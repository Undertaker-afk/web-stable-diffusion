# P2P Diffusion Backend Server

Optional backend server for the P2P WebGPU Diffusion application.

## Overview

This server provides:
- **Queue Management**: Centralized queue tracking across all connected clients
- **P2P Helper**: Can join rooms as a helper peer to assist with coordination
- **API Endpoints**: REST API for queue status and statistics
- **WebRTC Polyfill**: Enables server-side P2P connections using node-datachannel

## Installation

```bash
npm install
```

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will start on port 3000 by default (configurable via `PORT` environment variable).

## API Endpoints

### Health Check
```
GET /api/health
```
Returns server status and P2P capability.

### Global Statistics
```
GET /api/stats
```
Returns statistics across all rooms.

### Room Queue
```
GET /api/queue/:roomId
```
Returns the queue for a specific room.

### Add to Queue
```
POST /api/queue/:roomId
Content-Type: application/json

{
  "id": "task_123",
  "prompt": "A beautiful sunset",
  "options": { "model": "prx-1024" }
}
```

### Join as Helper
```
POST /api/join/:roomId
```
Makes the server join a room as a helper peer.

## P2P Support

The server can optionally participate in P2P networks using the `node-datachannel` package. This enables the server to:

1. Join rooms as a helper peer
2. Coordinate task distribution
3. Track peer activity

If `node-datachannel` is not installed, the server runs in API-only mode.

## Environment Variables

- `PORT` - Server port (default: 3000)

## Architecture

```
                    ┌─────────────────────┐
                    │   Express Server    │
                    │                     │
  REST API ────────►│  ┌───────────────┐  │
                    │  │ Queue Manager │  │
                    │  └───────────────┘  │
                    │          │          │
                    │  ┌───────▼───────┐  │
  P2P Network ◄────►│  │   Trystero    │  │
  (optional)        │  │  + Polyfill   │  │
                    │  └───────────────┘  │
                    └─────────────────────┘
```

## Note

This backend is **optional**. The P2P Diffusion application works entirely in the browser without it. The backend is useful for:

- Monitoring queue status across clients
- Providing a stable "helper" peer
- Centralized logging and analytics
