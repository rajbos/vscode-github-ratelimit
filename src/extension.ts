/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/


import * as vscode from 'vscode';
import { Octokit } from '@octokit/core';

let myStatusBarItem: vscode.StatusBarItem;
let intervalId: ReturnType<typeof setInterval> | undefined;
let exceededDate: Date | undefined;

// History tracking
interface RateLimitDataPoint {
	timestamp: number; // Unix timestamp in ms
	remaining: number;
	limit: number;
	used: number;
	reset: number; // Unix timestamp in seconds
}

let historyData: RateLimitDataPoint[] = [];
let lastHistorySaveTime = 0;
let extensionContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	
	// Load historical data from global state
	const savedHistory = context.globalState.get<RateLimitDataPoint[]>('rateLimitHistory', []);
	historyData = savedHistory;
	// Clean up old data (older than 1 hour)
	cleanupOldHistory();
	
	let pollInterval = vscode.workspace.getConfiguration('githubRateLimit').get<number>('pollIntervalSeconds', 1);
	myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	myStatusBarItem.name = 'GitHub Rate Limit';
	context.subscriptions.push(myStatusBarItem);

	function startPolling() {
		if (intervalId) {
			clearInterval(intervalId);
		}
		intervalId = setInterval(pollAndDisplayRateLimit, pollInterval * 1000);
	}

	startPolling();

	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('githubRateLimit.pollIntervalSeconds')) {
			pollInterval = vscode.workspace.getConfiguration('githubRateLimit').get<number>('pollIntervalSeconds', 1);
			startPolling();
		}
	});
	context.subscriptions.push(configChangeDisposable);

	context.subscriptions.push({
		dispose: () => {
			if (intervalId) {
				clearInterval(intervalId);
			}
		}
	});

	// Register command to show rate limit history
	const showHistoryCommand = vscode.commands.registerCommand('githubRateLimit.showHistory', () => {
		showRateLimitHistory(context);
	});
	context.subscriptions.push(showHistoryCommand);
}

async function pollAndDisplayRateLimit() {
	try {
		const session = await vscode.authentication.getSession('github', ['read:user']);
		if (!session) {
			myStatusBarItem.text = `$(alert) GitHub login required`;
			myStatusBarItem.show();
			return;
		}

		const octokit = new Octokit({ auth: session.accessToken });
		const response = await octokit.request('GET /rate_limit');
		const resources = response.data.resources;

		// Build tooltip with all resource rate limits as a markdown table
		const now = new Date();
		const tableRows: string[] = [
			'| Resource | Left | Reset |',
			'|----------|-----:|------:|'
		];
		for (const [name, info] of Object.entries(resources)) {
			if (typeof info !== 'object' || info === null) {
				continue;
			}
			const remaining = info.remaining;
			const reset = info.reset;
			if (typeof remaining !== 'number' || typeof reset !== 'number') {
				continue;
			}
			const resetDate = new Date(reset * 1000);
			const diffMs = resetDate.getTime() - now.getTime();
			const resetTime = humanizeDuration(diffMs);
			tableRows.push(`| ${name} | ${remaining} | ${resetTime} |`);
		}
		const tooltipText: vscode.MarkdownString = new vscode.MarkdownString(tableRows.join('\n'));

		// Use core as the main status bar value and store historical data
		const core = resources.core;
		if (core && typeof core.remaining === 'number' && typeof core.limit === 'number') {
			storeHistoryDataPoint(core.remaining, core.limit, core.reset);
		}
		
		const remaining = core?.remaining?.toString() ?? '?';
		const reset = core?.reset;
		let resetDate: Date | undefined;
		let resetTime = '';
		if (typeof reset === 'number') {
			resetDate = new Date(reset * 1000);
			const diffMs = resetDate.getTime() - now.getTime();
			resetTime = humanizeDuration(diffMs);
		}

		if (remaining === '0') {
			if (!exceededDate) {
				exceededDate = now;
			}
			myStatusBarItem.text = `$(github) Reset: ${resetTime}`;
			myStatusBarItem.tooltip = `GitHub Rate limit exceeded at or before ${exceededDate.toLocaleTimeString()}! Resets at ${resetDate?.toLocaleTimeString()}` + '\n' + tooltipText;
			myStatusBarItem.color = 'red';
			vscode.window.showWarningMessage(`$(alert) GitHub Rate limit exceeded! Resets at: ${resetTime}`);
		} else {
			if (exceededDate) {
				exceededDate = undefined; // Reset exceeded date if we are back to normal
			}
			myStatusBarItem.text = `$(github) ${remaining}`;
			myStatusBarItem.color = undefined;
			myStatusBarItem.tooltip = tooltipText;
		}
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : 'Unknown error';
		myStatusBarItem.text = `$(github) Error: ${errorMessage}`;
	}
	myStatusBarItem.show();
}

// Humanize duration in ms to a friendly string (e.g., "in 1 hour and 5 minutes")
function humanizeDuration(ms: number): string {
	if (ms <= 0) {
		return 'now';
	}
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${seconds}s`;
}

// Store rate limit data point with throttling (default every 5 minutes)
function storeHistoryDataPoint(remaining: number, limit: number, reset: number) {
	const now = Date.now();
	const historySaveInterval = vscode.workspace.getConfiguration('githubRateLimit')
		.get<number>('historySaveIntervalMinutes', 5) * 60 * 1000;
	
	// Only save if enough time has passed since last save
	if (now - lastHistorySaveTime >= historySaveInterval) {
		const dataPoint: RateLimitDataPoint = {
			timestamp: now,
			remaining,
			limit,
			used: limit - remaining,
			reset
		};
		
		historyData.push(dataPoint);
		lastHistorySaveTime = now;
		
		// Clean up old data (older than 1 hour)
		cleanupOldHistory();
		
		// Save to global state
		extensionContext.globalState.update('rateLimitHistory', historyData);
	}
}

// Remove data points older than 1 hour
function cleanupOldHistory() {
	const oneHourAgo = Date.now() - (60 * 60 * 1000);
	historyData = historyData.filter(point => point.timestamp >= oneHourAgo);
}

// Show rate limit history in a webview
function showRateLimitHistory(_context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'rateLimitHistory',
		'GitHub Rate Limit History',
		vscode.ViewColumn.One,
		{
			enableScripts: true
		}
	);

	// Clean up old data before displaying
	cleanupOldHistory();

	// Generate HTML for the webview
	panel.webview.html = getHistoryWebviewContent(historyData);
}

function getHistoryWebviewContent(data: RateLimitDataPoint[]): string {
	if (data.length === 0) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Rate Limit History</title>
	<style>
		body {
			padding: 20px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
		}
		.no-data {
			text-align: center;
			padding: 40px;
			font-size: 16px;
		}
	</style>
</head>
<body>
	<h1>GitHub Rate Limit History (Last Hour)</h1>
	<div class="no-data">
		<p>No historical data available yet.</p>
		<p>Data is collected every 5 minutes (configurable). Please wait for data to be collected.</p>
	</div>
</body>
</html>`;
	}

	// Calculate chart dimensions and data points
	const chartWidth = 800;
	const chartHeight = 400;
	const padding = { top: 40, right: 40, bottom: 60, left: 60 };
	const graphWidth = chartWidth - padding.left - padding.right;
	const graphHeight = chartHeight - padding.top - padding.bottom;

	// Find min/max for scaling
	const timestamps = data.map(d => d.timestamp);
	const minTime = Math.min(...timestamps);
	const maxTime = Math.max(...timestamps);
	const timeRange = maxTime - minTime || 1; // Avoid division by zero

	const maxLimit = Math.max(...data.map(d => d.limit));
	const maxValue = maxLimit * 1.1; // Add 10% padding at top

	// Generate SVG path for used rate limit
	const usedPoints = data.map((point, i) => {
		const x = padding.left + ((point.timestamp - minTime) / timeRange) * graphWidth;
		const y = padding.top + graphHeight - ((point.used / maxValue) * graphHeight);
		return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
	}).join(' ');

	// Generate SVG path for remaining rate limit
	const remainingPoints = data.map((point, i) => {
		const x = padding.left + ((point.timestamp - minTime) / timeRange) * graphWidth;
		const y = padding.top + graphHeight - ((point.remaining / maxValue) * graphHeight);
		return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
	}).join(' ');

	// Generate data points circles
	const dataCircles = data.map(point => {
		const x = padding.left + ((point.timestamp - minTime) / timeRange) * graphWidth;
		const yUsed = padding.top + graphHeight - ((point.used / maxValue) * graphHeight);
		const yRemaining = padding.top + graphHeight - ((point.remaining / maxValue) * graphHeight);
		const time = new Date(point.timestamp).toLocaleTimeString();
		return `
			<circle cx="${x}" cy="${yUsed}" r="4" fill="#f48771" opacity="0.8">
				<title>Used: ${point.used} at ${time}</title>
			</circle>
			<circle cx="${x}" cy="${yRemaining}" r="4" fill="#89d185" opacity="0.8">
				<title>Remaining: ${point.remaining} at ${time}</title>
			</circle>
		`;
	}).join('');

	// Generate X-axis labels (time)
	const numXLabels = Math.min(6, data.length);
	const xLabels = Array.from({ length: numXLabels }, (_, i) => {
		const index = Math.floor((i / (numXLabels - 1)) * (data.length - 1));
		const point = data[index];
		const x = padding.left + ((point.timestamp - minTime) / timeRange) * graphWidth;
		const time = new Date(point.timestamp).toLocaleTimeString();
		return `<text x="${x}" y="${chartHeight - 20}" text-anchor="middle" font-size="12">${time}</text>`;
	}).join('');

	// Generate Y-axis labels (rate limit count)
	const numYLabels = 5;
	const yLabels = Array.from({ length: numYLabels }, (_, i) => {
		const value = Math.round((i / (numYLabels - 1)) * maxLimit);
		const y = padding.top + graphHeight - ((value / maxValue) * graphHeight);
		return `
			<text x="${padding.left - 10}" y="${y + 5}" text-anchor="end" font-size="12">${value}</text>
			<line x1="${padding.left}" y1="${y}" x2="${chartWidth - padding.right}" y2="${y}" stroke="var(--vscode-panel-border)" stroke-width="1" opacity="0.2"/>
		`;
	}).join('');

	// Create summary table
	const summaryRows = data.map(point => {
		const time = new Date(point.timestamp).toLocaleTimeString();
		const resetTime = new Date(point.reset * 1000).toLocaleTimeString();
		return `
			<tr>
				<td>${time}</td>
				<td>${point.used}</td>
				<td>${point.remaining}</td>
				<td>${point.limit}</td>
				<td>${resetTime}</td>
			</tr>
		`;
	}).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Rate Limit History</title>
	<style>
		body {
			padding: 20px;
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
		}
		h1 {
			font-size: 24px;
			margin-bottom: 10px;
		}
		.subtitle {
			color: var(--vscode-descriptionForeground);
			margin-bottom: 30px;
		}
		.chart-container {
			margin: 30px 0;
			background-color: var(--vscode-editor-background);
			padding: 20px;
			border-radius: 4px;
			border: 1px solid var(--vscode-panel-border);
		}
		svg {
			display: block;
			margin: 0 auto;
		}
		.legend {
			display: flex;
			justify-content: center;
			gap: 30px;
			margin: 20px 0;
			font-size: 14px;
		}
		.legend-item {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.legend-color {
			width: 20px;
			height: 3px;
			border-radius: 2px;
		}
		.used-color {
			background-color: #f48771;
		}
		.remaining-color {
			background-color: #89d185;
		}
		.summary {
			margin-top: 40px;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			margin-top: 20px;
		}
		th, td {
			padding: 10px;
			text-align: left;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		th {
			font-weight: 600;
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
		}
		tr:hover {
			background-color: var(--vscode-list-hoverBackground);
		}
		.info-box {
			background-color: var(--vscode-textBlockQuote-background);
			border-left: 4px solid var(--vscode-textBlockQuote-border);
			padding: 12px 16px;
			margin: 20px 0;
			border-radius: 4px;
		}
	</style>
</head>
<body>
	<h1>GitHub Rate Limit History</h1>
	<div class="subtitle">Showing the last hour of data (collected every 5 minutes)</div>
	
	<div class="info-box">
		<strong>Data Points:</strong> ${data.length} | 
		<strong>Time Range:</strong> ${new Date(minTime).toLocaleTimeString()} - ${new Date(maxTime).toLocaleTimeString()}
	</div>

	<div class="legend">
		<div class="legend-item">
			<div class="legend-color used-color"></div>
			<span>Used Requests</span>
		</div>
		<div class="legend-item">
			<div class="legend-color remaining-color"></div>
			<span>Remaining Requests</span>
		</div>
	</div>

	<div class="chart-container">
		<svg width="${chartWidth}" height="${chartHeight}">
			<!-- Y-axis labels and grid lines -->
			${yLabels}
			
			<!-- Chart border -->
			<rect x="${padding.left}" y="${padding.top}" width="${graphWidth}" height="${graphHeight}" 
				fill="none" stroke="var(--vscode-panel-border)" stroke-width="2"/>
			
			<!-- Used rate limit line -->
			<path d="${usedPoints}" fill="none" stroke="#f48771" stroke-width="2"/>
			
			<!-- Remaining rate limit line -->
			<path d="${remainingPoints}" fill="none" stroke="#89d185" stroke-width="2"/>
			
			<!-- Data points -->
			${dataCircles}
			
			<!-- X-axis labels -->
			${xLabels}
			
			<!-- Axis labels -->
			<text x="${chartWidth / 2}" y="${chartHeight - 5}" text-anchor="middle" font-size="14" font-weight="600">Time</text>
			<text x="${padding.left / 2}" y="${chartHeight / 2}" text-anchor="middle" font-size="14" font-weight="600" transform="rotate(-90, ${padding.left / 2}, ${chartHeight / 2})">Requests</text>
		</svg>
	</div>

	<div class="summary">
		<h2>Detailed History</h2>
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Used</th>
					<th>Remaining</th>
					<th>Limit</th>
					<th>Reset Time</th>
				</tr>
			</thead>
			<tbody>
				${summaryRows}
			</tbody>
		</table>
	</div>
</body>
</html>`;
}