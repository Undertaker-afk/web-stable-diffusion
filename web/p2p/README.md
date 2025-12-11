# P2P WebGPU Diffusion

A peer-to-peer distributed image generation system using WebGPU and Trystero.

## Overview

This application enables multiple browsers to collaborate on AI image generation using WebGPU. It uses [Trystero](https://github.com/dmotz/trystero) for peer-to-peer communication, allowing browsers to share the computational load of running diffusion models.

## Features

- **Peer-to-Peer Networking**: Uses Trystero's Nostr strategy for zero-setup P2P connections
- **Distributed Computing**: Multiple browser workers collaborate on image generation
- **Optional Backend**: Queue management server that can assist with generation
- **WebGPU Acceleration**: Leverages GPU capabilities of connected peers
- **No Server Required**: Works entirely in the browser (backend is optional)

## Quick Start

### Browser Only (No Setup Required)

1. Open the app in a WebGPU-capable browser (Chrome 113+, Edge 113+)
2. Generate or enter a room ID
3. Share the room ID with collaborators
4. Start generating images!

### With Backend (Optional)

```bash
cd serv
npm install
npm start
```

The backend provides:
- Queue management across all clients
- Generation assistance (if GPU available)
- API endpoints for monitoring

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Browser A     │◄───►│   Browser B     │
│   (WebGPU)      │     │   (WebGPU)      │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │    P2P (Trystero)     │
         └───────────┬───────────┘
                     │
                     ▼ (optional)
         ┌───────────────────────┐
         │   Backend Server      │
         │   (Queue Manager)     │
         └───────────────────────┘
```

## Files

- `index.html` - Main application UI
- `p2p-diffusion.js` - Main application logic
- `p2p-network.js` - Trystero networking layer
- `worker-coordinator.js` - Distributed work coordination

## Model Integration

The app is designed to work with the PRX-1024 model from Photoroom:
- https://huggingface.co/spaces/Photoroom/PRX-1024-beta-version
- https://huggingface.co/Photoroom/prx-1024-t2i-beta

To integrate actual model inference, extend the `_processChunkLocally` method in `worker-coordinator.js`.

## API Endpoints (Backend)

When running the optional backend:

- `GET /api/health` - Health check
- `GET /api/stats` - Global statistics
- `GET /api/queue/:roomId` - Get room queue
- `POST /api/queue/:roomId` - Add task to queue
- `POST /api/join/:roomId` - Join room as helper

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Firefox Nightly with flag)
- Modern JavaScript (ES Modules)
- Sufficient GPU memory for model inference

## License

MIT
