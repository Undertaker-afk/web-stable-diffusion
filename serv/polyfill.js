/**
 * WebRTC Polyfill for Node.js
 * Uses node-datachannel to provide RTCPeerConnection for server-side Trystero
 */

let polyfill = null;

/**
 * Initialize the WebRTC polyfill
 * @returns {Object} The RTCPeerConnection constructor
 */
export async function initPolyfill() {
    if (polyfill) {
        return polyfill;
    }

    try {
        // Try to import node-datachannel polyfill
        const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = await import('node-datachannel/polyfill');
        
        polyfill = {
            RTCPeerConnection,
            RTCSessionDescription,
            RTCIceCandidate
        };
        
        console.log('[Polyfill] WebRTC polyfill loaded successfully');
        return polyfill;
    } catch (error) {
        console.warn('[Polyfill] node-datachannel not available, running without WebRTC support:', error.message);
        return null;
    }
}

/**
 * Get the RTCPeerConnection constructor
 * @returns {Function|null} RTCPeerConnection constructor or null if not available
 */
export function getRTCPeerConnection() {
    return polyfill?.RTCPeerConnection || null;
}

/**
 * Check if polyfill is available
 * @returns {boolean} True if polyfill is loaded
 */
export function isPolyfillAvailable() {
    return polyfill !== null;
}
