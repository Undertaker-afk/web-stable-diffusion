/**
 * P2P Diffusion Backend Server
 * 
 * Optional backend that provides:
 * - Queue management across all connected clients
 * - Background worker for helping with generation
 * - API endpoints for queue status
 * 
 * The system works without this backend - it's only used when available.
 */

import express from 'express';
import cors from 'cors';
import { initPolyfill, getRTCPeerConnection, isPolyfillAvailable } from './polyfill.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Queue storage
const queues = new Map(); // roomId -> queue[]
const roomStats = new Map(); // roomId -> { peers, generated, etc. }

// Trystero network connection (optional)
let network = null;

/**
 * Initialize Trystero network for server-side P2P
 */
async function initNetwork() {
    try {
        const polyfill = await initPolyfill();
        
        if (!polyfill) {
            console.log('[Server] Running without P2P capability');
            return;
        }

        // Dynamic import of Trystero
        const { joinRoom } = await import('trystero/nostr');
        
        console.log('[Server] Trystero loaded, P2P support enabled');
        
        // The server can join rooms as a "helper" peer
        // This is done on-demand when rooms have heavy load
        
    } catch (error) {
        console.warn('[Server] Could not initialize P2P network:', error.message);
    }
}

/**
 * Join a room as a helper peer
 */
async function joinAsHelper(roomId) {
    if (!isPolyfillAvailable()) {
        console.log('[Server] Cannot join room - polyfill not available');
        return null;
    }

    try {
        const { joinRoom } = await import('trystero/nostr');
        const rtcPolyfill = getRTCPeerConnection();
        
        const room = joinRoom(
            { 
                appId: 'p2p-webgpu-diffusion-v1',
                rtcPolyfill
            }, 
            roomId
        );

        console.log(`[Server] Joined room "${roomId}" as helper`);
        
        // Set up task handling
        const [sendResult, getTask] = room.makeAction('task');
        const [sendProgress] = room.makeAction('progress');
        const [sendCapabilities] = room.makeAction('capabilities');

        // Announce server capabilities
        setTimeout(() => {
            sendCapabilities({
                hasGPU: false, // Server doesn't have GPU typically
                isServer: true,
                canQueue: true,
                memory: process.memoryUsage().heapTotal / (1024 * 1024 * 1024)
            });
        }, 1000);

        // Handle incoming tasks
        getTask((task, peerId) => {
            console.log(`[Server] Received task from ${peerId}: ${task.type}`);
            // Queue the task for processing
            addToQueue(roomId, task);
        });

        return room;
    } catch (error) {
        console.error('[Server] Failed to join room:', error);
        return null;
    }
}

/**
 * Add task to queue
 */
function addToQueue(roomId, task) {
    if (!queues.has(roomId)) {
        queues.set(roomId, []);
    }
    
    const queue = queues.get(roomId);
    
    // Avoid duplicates
    if (!queue.find(t => t.id === task.id)) {
        queue.push({
            ...task,
            serverReceived: Date.now(),
            serverStatus: 'queued'
        });
        
        updateRoomStats(roomId);
    }
    
    return queue;
}

/**
 * Update room statistics
 */
function updateRoomStats(roomId) {
    const queue = queues.get(roomId) || [];
    const stats = roomStats.get(roomId) || { 
        created: Date.now(), 
        generated: 0,
        peers: 0 
    };
    
    stats.queueLength = queue.length;
    stats.lastActivity = Date.now();
    
    roomStats.set(roomId, stats);
}

// API Routes

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        p2pEnabled: isPolyfillAvailable(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

/**
 * Get queue for a room
 */
app.get('/api/queue/:roomId', (req, res) => {
    const { roomId } = req.params;
    const queue = queues.get(roomId) || [];
    const stats = roomStats.get(roomId) || null;
    
    res.json({
        roomId,
        queue: queue.map(task => ({
            id: task.id,
            prompt: task.prompt?.slice(0, 100),
            status: task.serverStatus,
            createdAt: task.createdAt,
            serverReceived: task.serverReceived
        })),
        stats
    });
});

/**
 * Add task to queue
 */
app.post('/api/queue/:roomId', (req, res) => {
    const { roomId } = req.params;
    const task = req.body;
    
    if (!task || !task.id) {
        return res.status(400).json({ error: 'Invalid task' });
    }
    
    const queue = addToQueue(roomId, task);
    
    res.json({
        success: true,
        position: queue.length,
        taskId: task.id
    });
});

/**
 * Get global stats
 */
app.get('/api/stats', (req, res) => {
    const stats = {
        activeRooms: queues.size,
        totalQueued: Array.from(queues.values()).reduce((sum, q) => sum + q.length, 0),
        p2pEnabled: isPolyfillAvailable(),
        rooms: {}
    };
    
    for (const [roomId, roomStat] of roomStats) {
        stats.rooms[roomId] = {
            queueLength: roomStat.queueLength,
            generated: roomStat.generated,
            lastActivity: roomStat.lastActivity
        };
    }
    
    res.json(stats);
});

/**
 * Join room as server helper
 */
app.post('/api/join/:roomId', async (req, res) => {
    const { roomId } = req.params;
    
    try {
        const room = await joinAsHelper(roomId);
        res.json({ 
            success: !!room,
            message: room ? 'Joined room as helper' : 'Could not join room'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Serve static files for the P2P app (if running standalone)
 */
app.use(express.static('../web/p2p'));

// Cleanup old queues periodically
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [roomId, stats] of roomStats) {
        if (now - stats.lastActivity > maxAge) {
            queues.delete(roomId);
            roomStats.delete(roomId);
            console.log(`[Server] Cleaned up inactive room: ${roomId}`);
        }
    }
}, 60 * 60 * 1000); // Every hour

// Start server
async function start() {
    // Initialize P2P network (optional)
    await initNetwork();
    
    app.listen(PORT, () => {
        console.log(`
╔════════════════════════════════════════════════════════════╗
║        P2P Diffusion Backend Server                         ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                   ║
║  P2P Support: ${isPolyfillAvailable() ? 'Enabled' : 'Disabled (install node-datachannel)'}           ║
║                                                            ║
║  API Endpoints:                                            ║
║    GET  /api/health          - Health check                ║
║    GET  /api/stats           - Global statistics           ║
║    GET  /api/queue/:roomId   - Get room queue              ║
║    POST /api/queue/:roomId   - Add task to queue           ║
║    POST /api/join/:roomId    - Join room as helper         ║
╚════════════════════════════════════════════════════════════╝
        `);
    });
}

start().catch(console.error);
