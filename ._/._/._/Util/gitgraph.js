#!/usr/bin/env node

/**
 * Git Graph Visualizer - Enhanced with keyboard navigation and touchpad support
 * A self-contained Node.js server that displays an interactive Git branch graph
 * 
 * Usage: node git-graph.js /path/to/your/git/repo [port]
 * Example: node git-graph.js . 3000
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import url from 'url';

// --- Configuration ---
const REPO_PATH = process.argv[2] || '.';
const PORT = parseInt(process.argv[3], 10) || 3000;

// Validate repository path
if (!fs.existsSync(path.join(REPO_PATH, '.git'))) {
    console.error(`Error: "${REPO_PATH}" is not a valid Git repository (no .git folder found).`);
    process.exit(1);
}

// --- Helper: Execute git command and return output ---
function git(args) {
    try {
        return execSync(`git ${args}`, {
            cwd: REPO_PATH,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
    } catch (error) {
        return '';
    }
}

// --- Fetch all commits with their details ---
function getAllCommits() {
    const rawLog = git(`log --all --pretty=format:'%H|%P|%an|%at|%s|%d' --decorate=full`);
    const rawLines = rawLog.split('\n').filter(l => l.trim());
    
    const commits = new Map();
    const branches = new Map();
    const tags = new Map();
    
    for (const line of rawLines) {
        const parts = line.split('|');
        if (parts.length < 6) continue;
        
        const hash = parts[0];
        const parentHashes = parts[1] ? parts[1].split(' ') : [];
        const author = parts[2];
        const timestamp = parseInt(parts[3], 10) * 1000;
        const subject = parts[4];
        const refsStr = parts[5];
        
        const branchMatches = [...refsStr.matchAll(/->\s*([^,\s)]+)/g)];
        const tagMatches = [...refsStr.matchAll(/tag:\s*([^,\s)]+)/g)];
        
        for (const match of branchMatches) {
            branches.set(match[1], hash);
        }
        for (const match of tagMatches) {
            tags.set(match[1], hash);
        }
        
        const simpleBranchMatches = [...refsStr.matchAll(/\(([^,\s)]+)\)/g)];
        for (const match of simpleBranchMatches) {
            const name = match[1];
            if (name !== 'HEAD' && !name.startsWith('tag:') && !name.startsWith('origin/')) {
                branches.set(name, hash);
            }
        }
        
        commits.set(hash, {
            hash,
            shortHash: hash.substring(0, 8),
            parentHashes,
            author,
            timestamp,
            subject,
            date: new Date(timestamp).toLocaleString(),
            refs: refsStr,
            isHead: refsStr.includes('HEAD')
        });
    }
    
    return { commits, branches, tags };
}

// --- Build graph structure with columns and connections ---
function buildGraphData(commitsMap, branchesMap, tagsMap) {
    const commits = Array.from(commitsMap.values());
    
    const children = new Map();
    for (const commit of commits) {
        for (const parent of commit.parentHashes) {
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(commit.hash);
        }
    }
    
    const branchTips = new Map();
    for (const [branch, hash] of branchesMap) {
        if (commitsMap.has(hash)) {
            branchTips.set(branch, hash);
        }
    }
    
    if (branchTips.size === 0 && commits.length > 0) {
        const mainTip = commits.reduce((a, b) => (children.get(a.hash)?.length || 0) > (children.get(b.hash)?.length || 0) ? a : b);
        branchTips.set('main', mainTip.hash);
    }
    
    const visited = new Set();
    const order = [];
    
    function dfs(hash) {
        if (visited.has(hash)) return;
        const commit = commitsMap.get(hash);
        if (!commit) return;
        visited.add(hash);
        for (const parent of commit.parentHashes) {
            dfs(parent);
        }
        order.push(hash);
    }
    
    for (const tip of branchTips.values()) {
        dfs(tip);
    }
    for (const commit of commits) {
        if (!visited.has(commit.hash)) {
            dfs(commit.hash);
        }
    }
    
    order.reverse();
    
    const laneColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#F7B05E', '#B0C4DE', '#F4A261', '#2A9D8F'];
    
    function getColor(col) {
        return laneColors[col % laneColors.length];
    }
    
    let nextColumn = 0;
    const tipColumns = new Map();
    const columnAssignments = new Map();
    
    for (const [branch, tipHash] of branchTips) {
        tipColumns.set(tipHash, nextColumn);
        columnAssignments.set(tipHash, nextColumn);
        nextColumn++;
    }
    
    const childMap = new Map();
    for (const commit of commits) {
        for (const parent of commit.parentHashes) {
            if (!childMap.has(parent)) childMap.set(parent, []);
            childMap.get(parent).push(commit.hash);
        }
    }
    
    for (const hash of order) {
        const commit = commitsMap.get(hash);
        if (!commit) continue;
        if (columnAssignments.has(hash)) continue;
        
        const childrenList = childMap.get(hash) || [];
        const assignedChildren = childrenList.filter(c => columnAssignments.has(c));
        if (assignedChildren.length > 0) {
            columnAssignments.set(hash, columnAssignments.get(assignedChildren[0]));
        } else {
            columnAssignments.set(hash, nextColumn++);
        }
    }
    
    const edges = [];
    for (const commit of commits) {
        const fromCol = columnAssignments.get(commit.hash);
        for (const parent of commit.parentHashes) {
            const toCol = columnAssignments.get(parent);
            const isMerge = commit.parentHashes.length > 1;
            edges.push({
                from: commit.hash,
                to: parent,
                fromCol,
                toCol,
                isMerge: isMerge && parent !== commit.parentHashes[0]
            });
        }
    }
    
    const graphData = {
        commits: commits.map(c => ({
            ...c,
            column: columnAssignments.get(c.hash),
            color: getColor(columnAssignments.get(c.hash))
        })),
        edges,
        branches: Array.from(branchesMap.entries()).map(([name, hash]) => ({ name, hash, column: columnAssignments.get(hash) })),
        tags: Array.from(tagsMap.entries()).map(([name, hash]) => ({ name, hash })),
        columnCount: nextColumn
    };
    
    return graphData;
}

// --- HTML/CSS/JS with enhanced navigation ---
function getHtml(graphData) {
    const commitsJson = JSON.stringify(graphData.commits);
    const edgesJson = JSON.stringify(graphData.edges);
    const branchesJson = JSON.stringify(graphData.branches);
    const tagsJson = JSON.stringify(graphData.tags);
    const columnCount = graphData.columnCount;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Git Graph Visualizer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            user-select: none;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: #1e1e2f;
            color: #e0e0e0;
            overflow: hidden;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            background: #2d2d3a;
            padding: 12px 20px;
            border-bottom: 1px solid #3e3e4a;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
            flex-wrap: wrap;
            gap: 10px;
        }
        .header h1 {
            font-size: 1.2rem;
            font-weight: 500;
        }
        .controls {
            display: flex;
            gap: 12px;
            align-items: center;
            flex-wrap: wrap;
        }
        button {
            background: #3e3e4a;
            border: none;
            color: #e0e0e0;
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.8rem;
            transition: background 0.2s;
        }
        button:hover {
            background: #5e5e6e;
        }
        .info {
            background: #2d2d3a;
            padding: 6px 12px;
            font-size: 0.8rem;
            border-radius: 6px;
            font-family: monospace;
        }
        .nav-controls {
            display: flex;
            gap: 8px;
            background: #2d2d3a;
            padding: 4px 8px;
            border-radius: 8px;
        }
        .nav-btn {
            background: #3e3e4a;
            padding: 4px 10px;
            font-size: 0.75rem;
        }
        .container {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: #1e1e2f;
        }
        canvas {
            display: block;
            background: #1e1e2f;
            cursor: grab;
        }
        canvas:active {
            cursor: grabbing;
        }
        .tooltip {
            position: absolute;
            background: #2d2d3a;
            border: 1px solid #5e5e6e;
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 12px;
            pointer-events: none;
            z-index: 100;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            max-width: 350px;
            backdrop-filter: blur(4px);
            display: none;
            font-family: monospace;
        }
        .legend {
            position: fixed;
            bottom: 16px;
            right: 16px;
            background: rgba(45,45,58,0.95);
            border-radius: 8px;
            padding: 10px 14px;
            font-size: 11px;
            backdrop-filter: blur(4px);
            pointer-events: none;
            z-index: 99;
            border: 1px solid #3e3e4a;
        }
        .legend span {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 2px;
            margin-right: 4px;
        }
        .status-bar {
            position: fixed;
            bottom: 16px;
            left: 16px;
            background: rgba(45,45,58,0.95);
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 11px;
            font-family: monospace;
            pointer-events: none;
            z-index: 99;
            border: 1px solid #3e3e4a;
        }
        @media (max-width: 768px) {
            .controls { font-size: 0.7rem; }
            button { padding: 4px 8px; }
            .info { font-size: 0.7rem; }
        }
    </style>
</head>
<body>
<div class="header">
    <h1>📊 Git Graph Visualizer</h1>
    <div class="controls">
        <div class="info">🖱️ Drag | ⌨️ Arrow keys | + Shift = fast | PgUp/PgDn | Home/End</div>
        <div class="nav-controls">
            <button class="nav-btn" id="navUp">↑</button>
            <button class="nav-btn" id="navDown">↓</button>
            <button class="nav-btn" id="navLeft">←</button>
            <button class="nav-btn" id="navRight">→</button>
        </div>
        <button id="resetView">Reset View</button>
    </div>
</div>
<div class="container">
    <canvas id="graphCanvas"></canvas>
</div>
<div id="tooltip" class="tooltip"></div>
<div class="legend">
    <div><span style="background: #FF6B6B;"></span> Branch lane</div>
    <div><span style="background: #4ECDC4;"></span> Merge line (dashed)</div>
    <div>● Commit &nbsp; 🌿 Branch tip &nbsp; ★ HEAD</div>
    <div style="margin-top: 4px;">⌨️ Arrow keys to navigate</div>
</div>
<div class="status-bar" id="statusBar">
    Loading...
</div>

<script>
    // Data from server
    const commits = ${commitsJson};
    const edges = ${edgesJson};
    const branches = ${branchesJson};
    const tags = ${tagsJson};
    const columnCount = ${columnCount};
    
    // Canvas setup
    const canvas = document.getElementById('graphCanvas');
    const container = document.querySelector('.container');
    const ctx = canvas.getContext('2d');
    const statusBar = document.getElementById('statusBar');
    
    // Viewport state
    let offsetX = 200, offsetY = 80;
    let scale = 1.0;
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    
    // Layout constants
    const COLUMN_WIDTH = 48;
    const ROW_HEIGHT = 68;
    const COMMIT_RADIUS = 8;
    
    // Precompute commit positions
    function computePositions() {
        const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
        sorted.forEach((commit, idx) => {
            commit.y = idx * ROW_HEIGHT + 40;
            commit.x = (commit.column + 0.5) * COLUMN_WIDTH;
        });
        for (const commit of commits) {
            if (commit.y === undefined) commit.y = 40;
            if (commit.x === undefined) commit.x = (commit.column + 0.5) * COLUMN_WIDTH;
        }
    }
    computePositions();
    
    // Get bounds
    function getBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const commit of commits) {
            minX = Math.min(minX, commit.x);
            maxX = Math.max(maxX, commit.x);
            minY = Math.min(minY, commit.y);
            maxY = Math.max(maxY, commit.y);
        }
        return { minX, maxX, minY, maxY };
    }
    
    // Update status bar with current view info
    function updateStatusBar() {
        const bounds = getBounds();
        const visibleWidth = canvas.width / scale;
        const visibleHeight = canvas.height / scale;
        const viewX = -offsetX / scale;
        const viewY = -offsetY / scale;
        
        const commitCount = commits.length;
        const visibleCommits = commits.filter(c => 
            c.x >= viewX - 100 && c.x <= viewX + visibleWidth + 100 &&
            c.y >= viewY - 100 && c.y <= viewY + visibleHeight + 100
        ).length;
        
        statusBar.innerHTML = \`📊 \${commitCount} commits | 👁️ \${visibleCommits} visible | 🔍 \${scale.toFixed(2)}x\`;
    }
    
    function resetView() {
        const bounds = getBounds();
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        const graphWidth = bounds.maxX - bounds.minX;
        const graphHeight = bounds.maxY - bounds.minY;
        const padding = 40;
        const targetScale = Math.min(
            (canvasWidth - padding) / (graphWidth + 0.1),
            (canvasHeight - padding) / (graphHeight + 0.1),
            2.0
        );
        scale = Math.max(0.2, Math.min(3.0, targetScale));
        offsetX = canvasWidth / 2 - centerX * scale;
        offsetY = canvasHeight / 2 - centerY * scale;
        draw();
        updateStatusBar();
    }
    
    // Panning functions with speed modifiers
    function pan(dx, dy) {
        offsetX += dx;
        offsetY += dy;
        draw();
        updateStatusBar();
    }
    
    function panWithSpeed(dx, dy, shiftPressed) {
        const speed = shiftPressed ? 3 : 1;
        pan(dx * speed, dy * speed);
    }
    
    function jumpToStart() {
        const bounds = getBounds();
        offsetY = canvas.height / 2 - bounds.minY * scale;
        draw();
        updateStatusBar();
    }
    
    function jumpToEnd() {
        const bounds = getBounds();
        offsetY = canvas.height / 2 - bounds.maxY * scale;
        draw();
        updateStatusBar();
    }
    
    function pageUp() {
        offsetY += canvas.height * 0.8;
        draw();
        updateStatusBar();
    }
    
    function pageDown() {
        offsetY -= canvas.height * 0.8;
        draw();
        updateStatusBar();
    }
    
    function resizeCanvas() {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        resetView();
    }
    window.addEventListener('resize', resizeCanvas);
    
    // Drawing helpers
    function worldToScreen(x, y) {
        return { x: x * scale + offsetX, y: y * scale + offsetY };
    }
    
    function drawLine(x1, y1, x2, y2, color, lineWidth = 2, isDashed = false) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        if (isDashed) ctx.setLineDash([6, 6]);
        else ctx.setLineDash([]);
        ctx.stroke();
    }
    
    function drawCommit(x, y, commit) {
        ctx.beginPath();
        ctx.arc(x, y, COMMIT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = commit.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        if (commit.isHead) {
            ctx.beginPath();
            ctx.arc(x, y, COMMIT_RADIUS + 3, 0, Math.PI * 2);
            ctx.strokeStyle = '#FFD966';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        
        ctx.font = '10px monospace';
        ctx.fillStyle = '#ddd';
        ctx.shadowBlur = 0;
        ctx.fillText(commit.shortHash, x + 12, y - 4);
        
        let subject = commit.subject.length > 40 ? commit.subject.substring(0, 37) + '...' : commit.subject;
        ctx.fillStyle = '#ccc';
        ctx.font = '11px sans-serif';
        ctx.fillText(subject, x + 12, y + 4);
    }
    
    function drawBranchLabels() {
        for (const branch of branches) {
            const commit = commits.find(c => c.hash === branch.hash);
            if (!commit) continue;
            const pos = worldToScreen(commit.x, commit.y);
            ctx.font = 'bold 12px sans-serif';
            ctx.fillStyle = '#F4A261';
            ctx.fillText('🌿 ' + branch.name, pos.x + 20, pos.y - 12);
        }
        for (const tag of tags) {
            const commit = commits.find(c => c.hash === tag.hash);
            if (!commit) continue;
            const pos = worldToScreen(commit.x, commit.y);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#96CEB4';
            ctx.fillText('🏷️ ' + tag.name, pos.x + 20, pos.y + 18);
        }
    }
    
    function drawEdges() {
        for (const edge of edges) {
            const fromCommit = commits.find(c => c.hash === edge.from);
            const toCommit = commits.find(c => c.hash === edge.to);
            if (!fromCommit || !toCommit) continue;
            
            const from = worldToScreen(fromCommit.x, fromCommit.y);
            const to = worldToScreen(toCommit.x, toCommit.y);
            let color = '#888';
            let lineWidth = 2;
            let dashed = false;
            
            if (edge.isMerge) {
                color = '#4ECDC4';
                lineWidth = 2.5;
                dashed = true;
            } else {
                color = fromCommit.color;
                lineWidth = 2.5;
            }
            
            drawLine(from.x, from.y, to.x, to.y, color, lineWidth, dashed);
        }
    }
    
    function draw() {
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.shadowBlur = 0;
        
        // Draw vertical column guides
        for (let i = 0; i <= columnCount; i++) {
            const x = (i + 0.5) * COLUMN_WIDTH;
            const screenX = x * scale + offsetX;
            ctx.beginPath();
            ctx.moveTo(screenX, 0);
            ctx.lineTo(screenX, canvas.height);
            ctx.strokeStyle = '#2a2a35';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
        
        drawEdges();
        
        for (const commit of commits) {
            const pos = worldToScreen(commit.x, commit.y);
            drawCommit(pos.x, pos.y, commit);
        }
        
        drawBranchLabels();
        
        ctx.restore();
    }
    
    // Enhanced mouse/touchpad handlers
    function handleMouseDown(e) {
        isDragging = true;
        dragStart.x = e.clientX - offsetX;
        dragStart.y = e.clientY - offsetY;
        canvas.style.cursor = 'grabbing';
    }
    
    function handleMouseMove(e) {
        if (!isDragging) return;
        offsetX = e.clientX - dragStart.x;
        offsetY = e.clientY - dragStart.y;
        draw();
        updateStatusBar();
    }
    
    function handleMouseUp() {
        isDragging = false;
        canvas.style.cursor = 'grab';
    }
    
    function handleWheel(e) {
        e.preventDefault();
        
        // Check if shift key is pressed for horizontal scrolling
        if (e.shiftKey) {
            const deltaX = e.deltaY || e.deltaX;
            pan(deltaX * 0.5, 0);
            return;
        }
        
        // Check if ctrl key is pressed for zoom
        if (e.ctrlKey) {
            const delta = e.deltaY > 0 ? 0.95 : 1.05;
            const newScale = scale * delta;
            if (newScale < 0.2 || newScale > 4) return;
            
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const worldX = (mouseX - offsetX) / scale;
            const worldY = (mouseY - offsetY) / scale;
            
            scale = newScale;
            offsetX = mouseX - worldX * scale;
            offsetY = mouseY - worldY * scale;
            draw();
            updateStatusBar();
            return;
        }
        
        // Normal vertical scrolling
        pan(0, e.deltaY * 0.5);
    }
    
    // Keyboard navigation
    function handleKeyDown(e) {
        const key = e.key;
        const shiftPressed = e.shiftKey;
        
        switch(key) {
            case 'ArrowUp':
                e.preventDefault();
                panWithSpeed(0, 30, shiftPressed);
                break;
            case 'ArrowDown':
                e.preventDefault();
                panWithSpeed(0, -30, shiftPressed);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                panWithSpeed(50, 0, shiftPressed);
                break;
            case 'ArrowRight':
                e.preventDefault();
                panWithSpeed(-50, 0, shiftPressed);
                break;
            case 'PageUp':
                e.preventDefault();
                pageUp();
                break;
            case 'PageDown':
                e.preventDefault();
                pageDown();
                break;
            case 'Home':
                e.preventDefault();
                jumpToStart();
                break;
            case 'End':
                e.preventDefault();
                jumpToEnd();
                break;
            case '+':
            case '=':
                e.preventDefault();
                const newScaleUp = Math.min(4, scale * 1.2);
                const centerXUp = canvas.width / 2;
                const centerYUp = canvas.height / 2;
                const worldXUp = (centerXUp - offsetX) / scale;
                const worldYUp = (centerYUp - offsetY) / scale;
                scale = newScaleUp;
                offsetX = centerXUp - worldXUp * scale;
                offsetY = centerYUp - worldYUp * scale;
                draw();
                updateStatusBar();
                break;
            case '-':
            case '_':
                e.preventDefault();
                const newScaleDown = Math.max(0.2, scale / 1.2);
                const centerXDown = canvas.width / 2;
                const centerYDown = canvas.height / 2;
                const worldXDown = (centerXDown - offsetX) / scale;
                const worldYDown = (centerYDown - offsetY) / scale;
                scale = newScaleDown;
                offsetX = centerXDown - worldXDown * scale;
                offsetY = centerYDown - worldYDown * scale;
                draw();
                updateStatusBar();
                break;
        }
    }
    
    function handleHover(e) {
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - offsetX) / scale;
        const worldY = (mouseY - offsetY) / scale;
        
        let hoveredCommit = null;
        for (const commit of commits) {
            const dx = worldX - commit.x;
            const dy = worldY - commit.y;
            if (Math.hypot(dx, dy) < COMMIT_RADIUS + 8) {
                hoveredCommit = commit;
                break;
            }
        }
        
        const tooltip = document.getElementById('tooltip');
        if (hoveredCommit) {
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY - 30) + 'px';
            tooltip.innerHTML = \`
                <strong>\${hoveredCommit.shortHash}</strong><br>
                <strong>\${hoveredCommit.subject}</strong><br>
                📅 \${hoveredCommit.date}<br>
                👤 \${hoveredCommit.author}<br>
                \${hoveredCommit.refs && hoveredCommit.refs !== '' ? '🏷️ ' + hoveredCommit.refs : ''}
            \`;
        } else {
            tooltip.style.display = 'none';
        }
    }
    
    // Attach events
    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('mousemove', handleHover);
    window.addEventListener('keydown', handleKeyDown);
    canvas.style.cursor = 'grab';
    
    // Button handlers
    document.getElementById('resetView').addEventListener('click', resetView);
    document.getElementById('navUp').addEventListener('click', () => pan(0, 30));
    document.getElementById('navDown').addEventListener('click', () => pan(0, -30));
    document.getElementById('navLeft').addEventListener('click', () => pan(50, 0));
    document.getElementById('navRight').addEventListener('click', () => pan(-50, 0));
    
    // Initial setup
    resizeCanvas();
    updateStatusBar();
    
    // Show welcome message
    setTimeout(() => {
        statusBar.innerHTML = \`📊 \${commits.length} commits | Ready! Use arrow keys to navigate\`;
        setTimeout(() => updateStatusBar(), 3000);
    }, 1000);
</script>
</body>
</html>`;
}

// --- Server setup ---
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/graph') {
        console.log('Fetching Git data...');
        const { commits, branches, tags } = getAllCommits();
        console.log(`Found ${commits.size} commits, ${branches.size} branches, ${tags.size} tags.`);
        const graphData = buildGraphData(commits, branches, tags);
        const html = getHtml(graphData);
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Git Graph Visualizer running at http://localhost:${PORT}`);
    console.log(`📁 Repository: ${path.resolve(REPO_PATH)}`);
    console.log(`\n✨ Navigation tips:`);
    console.log(`   • Arrow keys: pan in that direction`);
    console.log(`   • Shift + Arrow: faster panning (3x speed)`);
    console.log(`   • PageUp/PageDown: jump by screen height`);
    console.log(`   • Home/End: jump to start/end of graph`);
    console.log(`   • Ctrl + Scroll: zoom in/out`);
    console.log(`   • Shift + Scroll: horizontal pan`);
    console.log(`   • +/- keys: zoom in/out`);
    console.log(`\nPress Ctrl+C to stop`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down server...');
    server.close(() => process.exit(0));
});