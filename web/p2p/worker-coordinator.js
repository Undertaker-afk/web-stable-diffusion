/**
 * Worker Coordinator
 * Manages distributed GPU work across multiple peers
 */

export class WorkerCoordinator {
    constructor(network, selfId) {
        this.network = network;
        this.selfId = selfId;
        
        // Work queue
        this.queue = [];
        this.currentTask = null;
        this.taskResults = new Map();
        
        // Worker state
        this.workers = new Map(); // peerId -> worker state
        this.localWorker = null;
        
        // Coordination settings
        this.maxChunksPerWorker = 4;
        this.chunkTimeout = 60000; // 60 seconds
        
        // Event callbacks
        this.onProgressCallback = null;
        this.onCompleteCallback = null;
        this.onQueueChangeCallback = null;
        this.onLogCallback = null;
        
        // Backend connection
        this.backendUrl = null;
        this.backendAvailable = false;
        
        this._setupNetworkHandlers();
    }

    /**
     * Set up network event handlers
     */
    _setupNetworkHandlers() {
        // Handle incoming tasks
        this.network.onTask((task, peerId) => {
            this._log(`Received task ${task.id} from ${peerId.slice(0, 8)}...`);
            this._handleIncomingTask(task, peerId);
        });

        // Handle results from other peers
        this.network.onResult((result, peerId) => {
            this._log(`Received result from ${peerId.slice(0, 8)}...`);
            this._handleResult(result, peerId);
        });

        // Handle progress updates
        this.network.onProgress((progress, peerId) => {
            this._updateWorkerProgress(peerId, progress);
        });

        // Handle capability announcements
        this.network.onCapabilities((capabilities, peerId) => {
            this.workers.set(peerId, {
                id: peerId,
                capabilities,
                status: 'idle',
                currentChunk: null,
                progress: 0
            });
            this._log(`Worker ${peerId.slice(0, 8)}... joined with ${capabilities.hasGPU ? 'GPU' : 'CPU'}`);
        });

        // Handle queue sync
        this.network.onQueueUpdate((queueData, peerId) => {
            this._syncQueue(queueData, peerId);
        });

        // Handle binary chunks
        this.network.onChunk((data, peerId, metadata) => {
            this._handleChunk(data, peerId, metadata);
        });

        // Peer leave - reassign their work
        this.network.onPeerLeave((peerId) => {
            this._handleWorkerDisconnect(peerId);
        });
    }

    /**
     * Check backend availability
     */
    async checkBackend(url = '/api/health') {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(url, { 
                method: 'GET', 
                signal: controller.signal 
            });
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
                this.backendUrl = url.replace('/health', '');
                this.backendAvailable = true;
                this._log('Backend server connected');
                return true;
            }
        } catch (e) {
            this.backendAvailable = false;
            this._log('Backend not available - running in P2P-only mode');
        }
        return false;
    }

    /**
     * Add a generation task to the queue
     */
    async addTask(prompt, negativePrompt = '', options = {}) {
        const task = {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'generate',
            prompt,
            negativePrompt,
            options: {
                model: options.model || 'prx-1024',
                steps: options.steps || 20,
                width: options.width || 1024,
                height: options.height || 1024,
                ...options
            },
            createdAt: Date.now(),
            createdBy: this.selfId,
            status: 'pending',
            chunks: [],
            results: new Map()
        };

        this.queue.push(task);
        
        // Sync queue with peers
        this._broadcastQueueUpdate();
        
        // Notify backend if available
        if (this.backendAvailable) {
            this._notifyBackend(task);
        }

        this._log(`Added task ${task.id.slice(0, 12)}... to queue`);
        
        if (this.onQueueChangeCallback) {
            this.onQueueChangeCallback(this.queue);
        }

        // Start processing if not already
        this._processNextTask();

        return task.id;
    }

    /**
     * Process the next task in the queue
     */
    async _processNextTask() {
        if (this.currentTask || this.queue.length === 0) {
            return;
        }

        this.currentTask = this.queue.shift();
        this.currentTask.status = 'processing';
        
        this._log(`Starting task ${this.currentTask.id.slice(0, 12)}...`);

        // Get available workers
        const availableWorkers = this._getAvailableWorkers();
        
        if (availableWorkers.length === 0) {
            this._log('No workers available, processing locally');
            await this._processLocally(this.currentTask);
            return;
        }

        // Distribute work across workers
        await this._distributeWork(this.currentTask, availableWorkers);
    }

    /**
     * Get list of available workers (including self)
     */
    _getAvailableWorkers() {
        const workers = [];
        
        // Add self if we have GPU capability
        if (this.localWorker && this.localWorker.capabilities.hasGPU) {
            workers.push({
                id: this.selfId,
                capabilities: this.localWorker.capabilities,
                status: 'idle',
                isLocal: true
            });
        }

        // Add connected peers
        for (const [peerId, worker] of this.workers) {
            if (worker.status === 'idle' && worker.capabilities && worker.capabilities.hasGPU) {
                workers.push({ ...worker, isLocal: false });
            }
        }

        return workers;
    }

    /**
     * Distribute work chunks across available workers
     */
    async _distributeWork(task, workers) {
        const numWorkers = workers.length;
        
        // For stable diffusion, we can parallelize in several ways:
        // 1. Split latent space (not trivial)
        // 2. Run different steps on different workers
        // 3. Ensemble multiple generations
        // 
        // For now, we'll use a simple approach where the coordinator
        // manages the main pipeline and workers help with heavy computations
        
        // Create work chunks based on model steps
        const totalSteps = task.options.steps;
        const chunksPerWorker = Math.ceil(totalSteps / numWorkers);
        
        task.chunks = [];
        task.assignedWorkers = new Map();

        for (let i = 0; i < numWorkers; i++) {
            const startStep = i * chunksPerWorker;
            const endStep = Math.min(startStep + chunksPerWorker, totalSteps);
            
            if (startStep >= totalSteps) break;

            const chunk = {
                id: `chunk_${i}`,
                taskId: task.id,
                startStep,
                endStep,
                workerIndex: i,
                status: 'pending'
            };
            
            task.chunks.push(chunk);
            
            const worker = workers[i];
            task.assignedWorkers.set(worker.id, chunk);
            
            // Mark worker as busy
            if (!worker.isLocal) {
                const peerWorker = this.workers.get(worker.id);
                if (peerWorker) {
                    peerWorker.status = 'working';
                    peerWorker.currentChunk = chunk.id;
                }
            }

            // Send task to worker
            const workerTask = {
                ...task,
                chunk,
                type: 'process_chunk'
            };

            if (worker.isLocal) {
                // Process locally
                this._processChunkLocally(workerTask);
            } else {
                // Send to peer
                this.network.broadcastTask(workerTask, [worker.id]);
            }
        }

        this._log(`Distributed ${task.chunks.length} chunks to ${numWorkers} workers`);
    }

    /**
     * Process a single chunk locally
     */
    async _processChunkLocally(workerTask) {
        this._log(`Processing chunk ${workerTask.chunk.id} locally`);
        
        // This would integrate with the actual model runtime
        // For now, we simulate progress
        const chunk = workerTask.chunk;
        const steps = chunk.endStep - chunk.startStep;
        
        for (let i = 0; i < steps; i++) {
            const progress = (i + 1) / steps;
            
            if (this.onProgressCallback) {
                this.onProgressCallback({
                    taskId: workerTask.id,
                    chunkId: chunk.id,
                    step: chunk.startStep + i + 1,
                    totalSteps: workerTask.options.steps,
                    progress
                });
            }

            // Broadcast progress to peers
            this.network.broadcastProgress({
                taskId: workerTask.id,
                chunkId: chunk.id,
                progress,
                workerId: this.selfId
            });

            // Simulate step processing time
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Mark chunk complete
        chunk.status = 'complete';
        
        // Create dummy result for now
        const result = {
            taskId: workerTask.id,
            chunkId: chunk.id,
            workerId: this.selfId,
            data: null, // Would contain actual latent data
            status: 'complete'
        };

        this._handleResult(result, this.selfId);
    }

    /**
     * Handle incoming task from another peer
     */
    async _handleIncomingTask(task, peerId) {
        if (task.type === 'process_chunk') {
            await this._processChunkLocally(task);
        } else if (task.type === 'generate') {
            // Another peer is requesting we help with generation
            // Add to our queue
            this.queue.push({ ...task, receivedFrom: peerId });
            this._processNextTask();
        }
    }

    /**
     * Handle results from workers
     */
    _handleResult(result, peerId) {
        if (!this.currentTask || result.taskId !== this.currentTask.id) {
            return;
        }

        this.currentTask.results.set(result.chunkId, result);

        // Check if all chunks are complete
        const completedChunks = Array.from(this.currentTask.results.values())
            .filter(r => r.status === 'complete').length;
        
        if (completedChunks === this.currentTask.chunks.length) {
            this._completeTask();
        }
    }

    /**
     * Complete the current task
     */
    async _completeTask() {
        this._log(`Task ${this.currentTask.id.slice(0, 12)}... complete!`);
        
        this.currentTask.status = 'complete';
        this.currentTask.completedAt = Date.now();

        if (this.onCompleteCallback) {
            this.onCompleteCallback(this.currentTask);
        }

        // Reset current task
        const completedTask = this.currentTask;
        this.currentTask = null;

        // Process next task
        this._processNextTask();

        return completedTask;
    }

    /**
     * Process task entirely locally (no peer help)
     */
    async _processLocally(task) {
        this._log(`Processing task ${task.id.slice(0, 12)}... locally (no peers)`);
        
        // Simulate full generation
        const totalSteps = task.options.steps;
        
        for (let step = 0; step < totalSteps; step++) {
            const progress = (step + 1) / totalSteps;
            
            if (this.onProgressCallback) {
                this.onProgressCallback({
                    taskId: task.id,
                    step: step + 1,
                    totalSteps,
                    progress,
                    stage: step < 1 ? 'clip' : (step < totalSteps - 1 ? 'unet' : 'vae')
                });
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        task.status = 'complete';
        task.completedAt = Date.now();

        if (this.onCompleteCallback) {
            this.onCompleteCallback(task);
        }

        this.currentTask = null;
        this._processNextTask();
    }

    /**
     * Handle worker disconnection
     */
    _handleWorkerDisconnect(peerId) {
        const worker = this.workers.get(peerId);
        
        if (worker && worker.currentChunk && this.currentTask) {
            // Reassign the chunk
            this._log(`Worker ${peerId.slice(0, 8)}... disconnected, reassigning chunk`);
            
            const chunk = this.currentTask.chunks.find(c => c.id === worker.currentChunk);
            if (chunk && chunk.status !== 'complete') {
                chunk.status = 'pending';
                // Try to reassign
                const newWorker = this._getAvailableWorkers()[0];
                if (newWorker) {
                    this.network.broadcastTask({
                        ...this.currentTask,
                        chunk,
                        type: 'process_chunk'
                    }, [newWorker.id]);
                } else {
                    this._processChunkLocally({ ...this.currentTask, chunk });
                }
            }
        }

        this.workers.delete(peerId);
    }

    /**
     * Update worker progress
     */
    _updateWorkerProgress(peerId, progress) {
        const worker = this.workers.get(peerId);
        if (worker) {
            worker.progress = progress.progress;
        }

        if (this.onProgressCallback && this.currentTask) {
            // Aggregate progress from all workers
            const allProgress = Array.from(this.workers.values())
                .filter(w => w.status === 'working')
                .map(w => w.progress);
            
            if (this.localWorker && this.localWorker.progress !== undefined) {
                allProgress.push(this.localWorker.progress);
            }

            const avgProgress = allProgress.length > 0 
                ? allProgress.reduce((a, b) => a + b, 0) / allProgress.length 
                : 0;

            this.onProgressCallback({
                taskId: progress.taskId,
                progress: avgProgress,
                workers: this.workers.size + 1
            });
        }
    }

    /**
     * Handle binary chunk data
     */
    _handleChunk(data, peerId, metadata) {
        // Store chunk data for combining later
        if (this.currentTask && metadata.taskId === this.currentTask.id) {
            if (!this.taskResults.has(metadata.taskId)) {
                this.taskResults.set(metadata.taskId, new Map());
            }
            this.taskResults.get(metadata.taskId).set(metadata.chunkId, data);
        }
    }

    /**
     * Sync queue with peers
     */
    _syncQueue(queueData, peerId) {
        // Merge queue updates (simple approach: add missing tasks)
        for (const task of queueData.tasks || []) {
            if (!this.queue.find(t => t.id === task.id)) {
                this.queue.push(task);
            }
        }
        
        if (this.onQueueChangeCallback) {
            this.onQueueChangeCallback(this.queue);
        }
    }

    /**
     * Broadcast queue update to all peers
     */
    _broadcastQueueUpdate() {
        this.network.broadcastQueueUpdate({
            tasks: this.queue.map(t => ({
                id: t.id,
                prompt: t.prompt,
                status: t.status,
                createdBy: t.createdBy,
                createdAt: t.createdAt
            }))
        });
    }

    /**
     * Notify backend of new task
     */
    async _notifyBackend(task) {
        if (!this.backendAvailable || !this.backendUrl) return;
        
        try {
            await fetch(`${this.backendUrl}/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(task)
            });
        } catch (e) {
            console.warn('Failed to notify backend:', e);
        }
    }

    /**
     * Set local worker capabilities
     */
    setLocalCapabilities(capabilities) {
        this.localWorker = {
            id: this.selfId,
            capabilities,
            status: 'idle'
        };
    }

    /**
     * Log message
     */
    _log(message) {
        console.log(`[Coordinator] ${message}`);
        if (this.onLogCallback) {
            this.onLogCallback(message);
        }
    }

    // Callback setters
    onProgress(callback) { this.onProgressCallback = callback; }
    onComplete(callback) { this.onCompleteCallback = callback; }
    onQueueChange(callback) { this.onQueueChangeCallback = callback; }
    onLog(callback) { this.onLogCallback = callback; }

    /**
     * Get current queue
     */
    getQueue() {
        return this.queue;
    }

    /**
     * Get worker stats
     */
    getStats() {
        const gpuWorkers = Array.from(this.workers.values())
            .filter(w => w.capabilities && w.capabilities.hasGPU).length;
        
        return {
            totalPeers: this.workers.size,
            gpuWorkers: gpuWorkers + (this.localWorker?.capabilities?.hasGPU ? 1 : 0),
            queueLength: this.queue.length,
            currentTask: this.currentTask?.id
        };
    }
}
