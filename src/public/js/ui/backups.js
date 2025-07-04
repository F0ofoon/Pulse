PulseApp.ui = PulseApp.ui || {};

PulseApp.ui.backups = (() => {
    let backupsSearchInput = null;
    let resetBackupsButton = null;
    let backupsTabContent = null;
    let namespaceFilter = null;
    let pbsInstanceFilter = null;
    let lastUserUpdateTime = 0; // Track when user last triggered an update
    let isProcessingDateSelection = false; // Prevent re-entrancy during date selection
    
    // Enhanced cache for expensive data transformations
    let dataCache = {
        lastStateHash: null,
        processedBackupData: null,
        guestBackupStatus: null,
        // Fine-grained caching
        guestCache: new Map(), // Maps guestId to cached data with TTL
        tasksByGuestCache: new Map(),
        snapshotsByGuestCache: new Map(),
        lastCleanup: Date.now(),
        cacheStats: { hits: 0, misses: 0 }
    };
    
    // Cache TTL in milliseconds
    const CACHE_TTL = 30000; // 30 seconds for guest data
    const CACHE_CLEANUP_INTERVAL = 300000; // 5 minutes
    
    // DOM element cache to avoid repeated queries
    const domCache = {
        tableBody: null,
        noDataMsg: null,
        tableContainer: null,
        scrollableContainer: null,
        visualizationSection: null,
        calendarContainer: null,
        statusTextElement: null,
        pbsSummaryElement: null,
        detailCardContainer: null,
        loadingIndicator: null
    };
    
    // Row tracking for incremental updates
    const rowTracker = new Map(); // Maps guestId to row element
    
    // Initialize DOM cache
    function _initDomCache() {
        domCache.tableBody = document.getElementById('backups-overview-tbody');
        domCache.noDataMsg = document.getElementById('backups-no-data-message');
        domCache.tableContainer = document.getElementById('backups-table-container');
        domCache.scrollableContainer = document.querySelector('#backups .overflow-x-auto');
        domCache.visualizationSection = document.getElementById('backup-visualization-section');
        domCache.calendarContainer = document.getElementById('backup-calendar-heatmap');
        domCache.statusTextElement = document.getElementById('backups-status-text');
        domCache.pbsSummaryElement = document.getElementById('pbs-instances-summary');
        domCache.detailCardContainer = document.getElementById('backup-detail-card');
        domCache.loadingIndicator = document.getElementById('backups-loading-message');
    }
    
    function _generateStateHash(vmsData, containersData, pbsDataArray, pveBackups, namespaceFilter, pbsInstanceFilter) {
        // Enhanced hash generation with data sampling
        const vmCount = vmsData.length;
        const ctCount = containersData.length;
        const pbsCount = pbsDataArray.length;
        const pveTaskCount = pveBackups?.backupTasks?.length || 0;
        const pveStorageCount = pveBackups?.storageBackups?.length || 0;
        
        // Sample data for better change detection
        const vmSample = vmsData.length > 0 ? `${vmsData[0]?.id}-${vmsData[vmsData.length-1]?.id}` : '';
        const ctSample = containersData.length > 0 ? `${containersData[0]?.id}-${containersData[containersData.length-1]?.id}` : '';
        
        // Include timestamps for better cache invalidation
        const latestBackupTime = Math.max(
            ...pbsDataArray.flatMap(pbs => 
                (pbs.datastores || []).flatMap(ds => 
                    (ds.snapshots || []).map(s => s.timestamp || 0)
                )
            ),
            0
        );
        
        return `${vmCount}-${ctCount}-${pbsCount}-${pveTaskCount}-${pveStorageCount}-${namespaceFilter || 'all'}-${pbsInstanceFilter || 'all'}-${vmSample}-${ctSample}-${latestBackupTime}`;
    }
    
    // Clean up expired cache entries
    function _cleanupCache() {
        const now = Date.now();
        if (now - dataCache.lastCleanup < CACHE_CLEANUP_INTERVAL) return;
        
        // Clean up guest cache
        for (const [guestId, data] of dataCache.guestCache) {
            if (now - data.timestamp > CACHE_TTL) {
                dataCache.guestCache.delete(guestId);
            }
        }
        
        // Clean up component caches
        for (const [key, data] of dataCache.tasksByGuestCache) {
            if (now - data.timestamp > CACHE_TTL) {
                dataCache.tasksByGuestCache.delete(key);
            }
        }
        
        for (const [key, data] of dataCache.snapshotsByGuestCache) {
            if (now - data.timestamp > CACHE_TTL) {
                dataCache.snapshotsByGuestCache.delete(key);
            }
        }
        
        dataCache.lastCleanup = now;
    }


    function _initTableFixedLine() {
        // No longer needed - using CSS border styling instead
    }

    function init() {
        // Initialize DOM cache first
        _initDomCache();
        
        backupsSearchInput = document.getElementById('backups-search');
        resetBackupsButton = document.getElementById('reset-backups-filters-button');
        backupsTabContent = document.getElementById('backups');

        if (backupsSearchInput) {
            const debouncedUpdate = PulseApp.utils.debounce(() => updateBackupsTab(true), 300);
            backupsSearchInput.addEventListener('input', debouncedUpdate);
        } else {
            console.warn('Element #backups-search not found - backups text filtering disabled.');
        }

        if (resetBackupsButton) {
            resetBackupsButton.addEventListener('click', resetBackupsView);
        }

        if (backupsTabContent) {
            backupsTabContent.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && backupsTabContent.contains(document.activeElement)) {
                    resetBackupsView();
                }
            });
        }
        
        // Add event listeners for filter changes
        const filterElements = [
            'backups-filter-type-all', 'backups-filter-type-vm', 'backups-filter-type-ct',
            'backups-filter-backup-all', 'backups-filter-backup-pbs', 'backups-filter-backup-pve', 'backups-filter-backup-snapshots',
            'backups-filter-status-all', 'backups-filter-status-ok', 'backups-filter-status-stale', 'backups-filter-status-warning', 'backups-filter-status-none',
            'backups-filter-failures'
        ];
        
        filterElements.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('change', () => {
                    // Update state based on which filter was changed
                    if (id.includes('filter-type-')) {
                        // Guest type filter
                        if (element.checked) {
                            const type = id.replace('backups-filter-type-', '');
                            PulseApp.state.set('backupsFilterGuestType', type);
                        }
                    } else if (id.includes('filter-backup-')) {
                        // Backup type filter
                        if (element.checked) {
                            const backupType = id.replace('backups-filter-backup-', '');
                            PulseApp.state.set('backupsFilterBackupType', backupType);
                        }
                    } else if (id.includes('filter-status-')) {
                        // Health status filter
                        if (element.checked) {
                            const status = id.replace('backups-filter-status-', '');
                            PulseApp.state.set('backupsFilterHealth', status);
                        }
                    } else if (id === 'backups-filter-failures') {
                        // Failures checkbox
                        PulseApp.state.set('backupsFilterFailures', element.checked);
                    }
                    
                    updateBackupsTab(true);
                });
            }
        });
        
        // Global ESC key handler for backups tab
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                // Check if backups tab is currently active
                const backupsTab = document.querySelector('.tab[data-tab="backups"]');
                const isBackupsTabActive = backupsTab && backupsTab.classList.contains('active');
                
                if (isBackupsTabActive) {
                    // Check if there are any active filters to clear
                    const calendarFilter = PulseApp.state.get('calendarDateFilter');
                    const searchTerm = backupsSearchInput ? backupsSearchInput.value : '';
                    const typeFilter = PulseApp.state.get('backupsFilterGuestType');
                    const healthFilter = PulseApp.state.get('backupsFilterHealth');
                    const backupTypeFilter = PulseApp.state.get('backupsFilterBackupType');
                    const failuresFilter = PulseApp.state.get('backupsFilterFailures');
                    
                    const hasActiveFilters = calendarFilter || 
                                           searchTerm || 
                                           (typeFilter && typeFilter !== 'all') || 
                                           (healthFilter && healthFilter !== 'all') ||
                                           (backupTypeFilter && backupTypeFilter !== 'all') ||
                                           failuresFilter;
                    
                    if (hasActiveFilters) {
                        event.preventDefault();
                        resetBackupsView();
                    }
                }
            }
        });
        
        // Initialize mobile scroll indicators
        if (window.innerWidth < 768) {
            PulseApp.utils.initMobileScrollIndicators('#backups');
        }
        
        // Initialize snapshot modal handlers
        _initSnapshotModal();
        
        // Initialize namespace filter
        _initNamespaceFilter();
        
        // Initialize PBS instance filter
        _initPbsInstanceFilter();
    }

    function calculateBackupSummary(backupStatusByGuest) {
        let totalGuests = backupStatusByGuest.length;
        let healthyCount = 0;
        let warningCount = 0;
        let errorCount = 0;
        let noneCount = 0;
        let totalPbsBackups = 0;
        let totalPveBackups = 0;
        let totalSnapshots = 0;

        backupStatusByGuest.forEach(guest => {
            
            switch (guest.backupHealthStatus) {
                case 'ok':
                case 'stale':
                    healthyCount++;
                    break;
                case 'old':
                    warningCount++;
                    break;
                case 'failed':
                    errorCount++;
                    break;
                case 'none':
                    noneCount++;
                    break;
            }
            
            totalPbsBackups += guest.pbsBackups || 0;
            totalPveBackups += guest.pveBackups || 0;
            totalSnapshots += guest.snapshotCount || 0;
            
        });

        return {
            totalGuests,
            healthyCount,
            warningCount,
            errorCount,
            noneCount,
            totalPbsBackups,
            totalPveBackups,
            totalSnapshots,
            healthyPercent: totalGuests > 0 ? (healthyCount / totalGuests) * 100 : 0
        };
    }


    function createNodeBackupSummaryCard(nodeName, guestStatuses) {
        const card = document.createElement('div');
        card.className = 'bg-white dark:bg-gray-800 shadow-md rounded-lg p-2 border border-gray-200 dark:border-gray-700 flex flex-col gap-1';
        
        let healthyCount = 0;
        let warningCount = 0;
        let errorCount = 0;
        let noneCount = 0;
        let pbsTotal = 0;
        let pveTotal = 0;
        let snapshotTotal = 0;
        
        guestStatuses.forEach(guest => {
            switch (guest.backupHealthStatus) {
                case 'ok':
                case 'stale':
                    healthyCount++;
                    break;
                case 'old':
                    warningCount++;
                    break;
                case 'failed':
                    errorCount++;
                    break;
                case 'none':
                    noneCount++;
                    break;
            }
            pbsTotal += guest.pbsBackups || 0;
            pveTotal += guest.pveBackups || 0;
            snapshotTotal += guest.snapshotCount || 0;
        });
        
        const totalGuests = guestStatuses.length;
        const healthyPercent = totalGuests > 0 ? (healthyCount / totalGuests) * 100 : 0;
        
        // Sort guests by backup health (worst first for visibility)
        const sortedGuests = [...guestStatuses].sort((a, b) => {
            const priority = { 'failed': 0, 'none': 1, 'old': 2, 'stale': 3, 'ok': 4 };
            return priority[a.backupHealthStatus] - priority[b.backupHealthStatus];
        }); // Show all guests
        
        card.innerHTML = `
            <div class="flex justify-between items-center">
                <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">${nodeName}</h3>
                <span class="text-xs text-gray-500 dark:text-gray-400">${totalGuests} guest${totalGuests > 1 ? 's' : ''}</span>
            </div>
            <div class="flex items-center gap-2 text-[10px] text-gray-600 dark:text-gray-400">
                <div class="flex items-center gap-1">
                    <div class="w-2 h-2 bg-yellow-500 rounded-sm"></div>
                    <span>${snapshotTotal}</span>
                </div>
                <div class="flex items-center gap-1">
                    <div class="w-2 h-2 bg-orange-500 rounded-sm"></div>
                    <span>${pveTotal}</span>
                </div>
                <div class="flex items-center gap-1">
                    <div class="w-2 h-2 bg-purple-500 rounded-sm"></div>
                    <span>${pbsTotal}</span>
                </div>
            </div>
            ${sortedGuests.map(guest => {
                const statusColor = PulseApp.utils.getBackupStatusColor(guest.backupHealthStatus);
                
                const statusIcon = {
                    'ok': '●',
                    'stale': '●',
                    'old': '●',
                    'failed': '●',
                    'none': '○'
                }[guest.backupHealthStatus] || '○';
                
                return `
                    <div class="text-[10px] text-gray-600 dark:text-gray-400 flex items-center gap-1">
                        <span class="${statusColor}">${statusIcon}</span>
                        <span class="truncate flex-1">${guest.guestName}</span>
                        <span class="text-[9px]">${guest.guestId}</span>
                    </div>
                `;
            }).join('')}
        `;
        
        return card;
    }

    function _extractBackupTypeFromVolid(volid, vmid) {
        // Extract type from volid format: vzdump-{type}-{vmid}-{timestamp}
        const volidMatch = volid.match(/vzdump-(qemu|lxc)-(\d+)-/);
        if (volidMatch) {
            return volidMatch[1] === 'qemu' ? 'vm' : 'ct';
        }
        
        // Fallback: try to determine from guest data if available
        // Look up the guest in current data to determine actual type
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const allGuests = [...vmsData, ...containersData];
        
        const guest = allGuests.find(g => parseInt(g.vmid, 10) === parseInt(vmid, 10));
        if (guest) {
            return guest.type === 'qemu' ? 'vm' : 'ct';
        }
        
        // Final fallback: assume VM if no match found
        console.warn('[Backups] Could not determine backup type from volid:', volid, 'vmid:', vmid);
        return 'vm';
    }

    function _getInitialBackupData() {
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        const initialDataReceived = PulseApp.state.get('initialDataReceived');
        
        const allGuestsUnfiltered = [...vmsData, ...containersData];
        
        // Get namespace filter early to filter guests and tasks
        const namespaceFilter = PulseApp.state.get('backupsFilterNamespace') || 'all';
        
        // Check if we can use cached data (now includes namespace filter in hash)
        const pbsInstanceFilterValue = PulseApp.state.get('backupsFilterPbsInstance') || 'all';
        const currentHash = _generateStateHash(vmsData, containersData, pbsDataArray, pveBackups, namespaceFilter, pbsInstanceFilterValue);
        if (dataCache.lastStateHash === currentHash && dataCache.processedBackupData) {
            return dataCache.processedBackupData;
        }
        

        // PBS instance filter already retrieved above for cache hash
        
        // Filter PBS instances based on selection
        const filteredPbsDataArray = pbsInstanceFilterValue === 'all'
            ? pbsDataArray
            : pbsDataArray.filter((_, index) => index.toString() === pbsInstanceFilterValue);
        
        
        // Filter PBS backup tasks by namespace if possible
        let pbsBackupTasks = filteredPbsDataArray.flatMap(pbs => {
            return (pbs.backupTasks?.recentTasks || []).map(task => ({
                ...task,
                guestId: task.id?.split('/')[1] || task.guestId || null,
                guestTypePbs: task.id?.split('/')[0] || task.guestType || null,
                pbsInstanceName: pbs.pbsInstanceName,
                source: 'pbs'
            }));
        });
        
        // Track guest+node combinations for namespace filtering
        const guestNodeCombosInNamespace = new Set();
        
        // If a specific namespace is selected, filter backup tasks using guest+node matching
        if (namespaceFilter !== 'all') {
            // Populate guest+node combinations that have backups in the selected namespace
            filteredPbsDataArray.forEach(pbsInstance => {
                (pbsInstance.datastores || []).forEach(ds => {
                    (ds.snapshots || []).forEach(snap => {
                        const snapNamespace = snap.namespace || 'root';
                        if (snapNamespace === namespaceFilter) {
                            const guestId = snap['backup-id'];
                            const owner = snap.owner || '';
                            const comment = snap.comment || '';
                            
                            // Note: We cannot reliably extract guest names from comments
                            // Comments are user-configurable and inconsistent
                            
                            
                            // Extract owner token if available
                            let ownerToken = null;
                            if (owner && owner.includes('!')) {
                                ownerToken = owner.split('!')[1].toLowerCase();
                            }
                            
                            // Find all guests that could match this backup using VMID + Owner
                            const matchingGuests = allGuestsUnfiltered.filter(guest => {
                                // Must match VMID
                                if (guest.vmid != guestId) return false;
                                
                                // Skip guest name matching - comments are unreliable
                                // We can only match by VMID + owner token
                                
                                // Use owner token to differentiate between same-named guests
                                if (ownerToken) {
                                    const guestEndpoint = guest.endpointId || 'primary';
                                    
                                    // For primary endpoint (cluster), exclude if owner matches a secondary endpoint
                                    if (guestEndpoint === 'primary') {
                                        // Check if any secondary endpoint has a nodeDisplayName matching the token
                                        const isSecondaryToken = allGuestsUnfiltered.some(g => {
                                            if (!g.nodeDisplayName || !g.endpointId || g.endpointId === 'primary') return false;
                                            const clusterName = g.nodeDisplayName.split(' - ')[0].toLowerCase();
                                            return clusterName === ownerToken;
                                        });
                                        
                                        // If owner token matches a secondary endpoint, this backup isn't from primary
                                        if (isSecondaryToken) {
                                            return false;
                                        }
                                        return true;
                                    } else {
                                        // For secondary endpoints, check if the guest's cluster name matches the token
                                        if (!guest.nodeDisplayName) return false;
                                        const clusterName = guest.nodeDisplayName.split(' - ')[0].toLowerCase();
                                        return ownerToken === clusterName;
                                    }
                                }
                                
                                return true;
                            });
                            
                            
                            // If we found matches based on VMID + owner, use those
                            if (matchingGuests.length > 0) {
                                matchingGuests.forEach(guest => {
                                    guestNodeCombosInNamespace.add(`${guestId}-${guest.node}`);
                                });
                            } else {
                                // No matches found - include all guests with this VMID
                                allGuestsUnfiltered.forEach(guest => {
                                    if (guest.vmid == guestId) {
                                        guestNodeCombosInNamespace.add(`${guestId}-${guest.node}`);
                                    }
                                });
                            }
                        }
                    });
                });
            });
            
            // Filter backup tasks to only include those for the correct guest+node combinations
            pbsBackupTasks = pbsBackupTasks.filter(task => {
                const taskKey = `${task.guestId}-${task.node || 'unknown'}`;
                return guestNodeCombosInNamespace.has(taskKey);
            });
        }
        
        // Filter guests by namespace using guest+node matching from PBS comment fields
        let allGuests;
        const vmidsInNamespace = new Set();
        
        if (namespaceFilter !== 'all') {
            // Use the already populated guestNodeCombosInNamespace from above
            // Filter allGuests to only include those that have backups in the selected namespace
            // Extract just the VMIDs from the namespace (ignore node mismatches)
            guestNodeCombosInNamespace.forEach(combo => {
                const vmid = combo.split('-')[0];
                vmidsInNamespace.add(vmid);
            });
            
            // Filter guests by VMID only (don't require exact node match)
            allGuests = allGuestsUnfiltered.filter(guest => {
                return vmidsInNamespace.has(guest.vmid.toString());
            });
            
        } else {
            allGuests = allGuestsUnfiltered;
        }

        // PVE backup tasks are job-level and don't map to individual guests well
        // Focus on actual backup files instead of job tasks for PVE backup counting
        const pveBackupTasks = [];
        
        // Create debug element
        let debugEl = document.getElementById('pve-debug');
        if (!debugEl) {
            debugEl = document.createElement('div');
            debugEl.id = 'pve-debug';
            debugEl.style.cssText = 'position:fixed;top:10px;right:10px;background:yellow;padding:10px;border:2px solid red;z-index:9999;font-size:12px;max-width:300px;';
            document.body.appendChild(debugEl);
        }
        debugEl.remove();

        const allRecentBackupTasks = [...pbsBackupTasks, ...pveBackupTasks];
        
        
        // Debug failed tasks
        const failedTasks = allRecentBackupTasks.filter(task => task.status !== 'OK');
        
        // Combine PBS snapshots and PVE storage backups
        let pbsSnapshots = filteredPbsDataArray.flatMap(pbsInstance =>
            (pbsInstance.datastores || []).flatMap(ds =>
                (ds.snapshots || []).map(snap => ({
                    ...snap,
                    pbsInstanceName: pbsInstance.pbsInstanceName,
                    datastoreName: ds.name,
                    backupType: snap['backup-type'],
                    backupVMID: snap['backup-id'],
                    namespace: snap.namespace || 'root', // Preserve namespace information
                    source: 'pbs'
                }))
            )
        );
        
        // Filter PBS snapshots by namespace if a specific namespace is selected
        if (namespaceFilter !== 'all') {
            pbsSnapshots = pbsSnapshots.filter(snap => snap.namespace === namespaceFilter);
        }

        const pveStorageBackups = (pveBackups.storageBackups || []).map(backup => {
            // Defensive programming: ensure required fields exist
            if (!backup.ctime || !backup.vmid || !backup.volid) {
                console.warn('[Backups] Skipping PVE backup with missing required fields:', backup);
                return null;
            }
            
            // Ensure vmid is a string for consistent key generation
            const vmidStr = String(backup.vmid);
            
            return {
                'backup-time': backup.ctime,
                ctime: backup.ctime, // Include ctime directly for calendar
                backupType: _extractBackupTypeFromVolid(backup.volid, vmidStr),
                backupVMID: vmidStr,
                vmid: vmidStr, // Ensure vmid is preserved for filtering
                size: backup.size,
                protected: backup.protected,
                storage: backup.storage,
                volid: backup.volid,
                node: backup.node,
                endpointId: backup.endpointId,
                source: 'pve'
            };
        }).filter(Boolean); // Remove null entries
        
        // PVE guest snapshots are NOT backups - they should be handled separately
        // Only include actual PVE backup files in the backup processing
        const allSnapshots = [...pbsSnapshots, ...pveStorageBackups];
        
        // Now that pveStorageBackups is defined, update the guest filter if namespace filtering is active
        if (namespaceFilter !== 'all') {
            // Add PVE backup VMIDs to the set (PVE backups should always be shown)
            pveStorageBackups.forEach(backup => {
                vmidsInNamespace.add(backup.vmid.toString());
            });
            
            // Re-filter guests to include those with PBS backups in namespace OR PVE backups
            allGuests = allGuestsUnfiltered.filter(guest => {
                return vmidsInNamespace.has(guest.vmid.toString());
            });
        }

        // Pre-index data by guest ID and type for performance
        const tasksByGuest = new Map();
        const snapshotsByGuest = new Map();

        allRecentBackupTasks.forEach(task => {
            // Include node/endpointId in key to handle multiple clusters with same vmid
            const nodeKey = task.node ? `-${task.node}` : (task.endpointId ? `-${task.endpointId}` : '');
            const key = `${task.guestId}-${task.guestTypePbs}${nodeKey}`;
            if (!tasksByGuest.has(key)) tasksByGuest.set(key, []);
            tasksByGuest.get(key).push(task);
        });
        

        allSnapshots.forEach(snap => {
            // Different key strategies for PBS vs PVE:
            // PBS: Include PBS instance name to prevent cross-PBS contamination
            // PVE: create both node-specific AND generic keys for cross-node matching
            if (snap.source === 'pbs') {
                // For PBS, we need to create endpoint-specific keys based on the owner field
                // This ensures backups only show for the correct guest
                const owner = snap.owner || '';
                let endpointSuffix = '';
                let matchingGuest = null; // Define outside the if block
                
                if (owner && owner.includes('!')) {
                    // Extract token name which identifies the endpoint
                    const ownerToken = owner.split('!')[1].toLowerCase();
                    
                    // Map token to endpoint
                    // Find if any guest from a secondary endpoint has a nodeDisplayName that matches the token
                    matchingGuest = allGuestsUnfiltered.find(g => {
                        if (!g.nodeDisplayName || !g.endpointId || g.endpointId === 'primary') return false;
                        // nodeDisplayName might be just "pimox" or "pimox - pi" format
                        const clusterName = g.nodeDisplayName.split(' - ')[0].toLowerCase();
                        return clusterName === ownerToken;
                    });
                    
                    
                    if (matchingGuest) {
                        // This backup is from a secondary endpoint
                        // Use the actual endpoint ID for consistency
                        endpointSuffix = `-${matchingGuest.endpointId}`;
                    } else {
                        // This backup is from primary endpoint (or token doesn't match any secondary)
                        endpointSuffix = '-primary';
                    }
                } else {
                    // No owner info - mark as unknown/ambiguous
                    endpointSuffix = '-unknown';
                }
                
                const namespace = snap.namespace || 'root';
                // Include endpoint suffix in the key to separate backups by source
                const key = `${snap.backupVMID}-${snap.backupType}-${snap.pbsInstanceName}-${namespace}${endpointSuffix}`;
                
                
                if (!snapshotsByGuest.has(key)) snapshotsByGuest.set(key, []);
                snapshotsByGuest.get(key).push(snap);
            } else {
                // PVE: create both node-specific and endpoint-generic keys (cross-node within same cluster)
                const endpointKey = snap.endpointId ? `-${snap.endpointId}` : '';
                const endpointGenericKey = `${snap.backupVMID}-${snap.backupType}${endpointKey}`;
                const nodeKey = snap.node ? `-${snap.node}` : '';
                const fullNodeSpecificKey = `${snap.backupVMID}-${snap.backupType}${endpointKey}${nodeKey}`;
                
                // Add to endpoint-generic key (for cross-node matching within same cluster)
                if (!snapshotsByGuest.has(endpointGenericKey)) snapshotsByGuest.set(endpointGenericKey, []);
                snapshotsByGuest.get(endpointGenericKey).push(snap);
                
                // Add to fully specific key (for exact matching)
                if (!snapshotsByGuest.has(fullNodeSpecificKey)) snapshotsByGuest.set(fullNodeSpecificKey, []);
                snapshotsByGuest.get(fullNodeSpecificKey).push(snap);
                
            }
        });

        // Pre-calculate day boundaries for 7-day analysis
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const dayBoundaries = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(now);
            dayStart.setDate(now.getDate() - i);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayStart.getDate() + 1);
            dayBoundaries.push({
                start: Math.floor(dayStart.getTime() / 1000),
                end: Math.floor(dayEnd.getTime() / 1000)
            });
        }

        const threeDaysAgo = Math.floor(Date.now() / 1000) - (3 * 24 * 60 * 60);
        const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);


        const result = { 
            allGuests, 
            initialDataReceived, 
            tasksByGuest, 
            snapshotsByGuest, 
            dayBoundaries,
            threeDaysAgo,
            sevenDaysAgo
        };
        
        // Cache the processed data
        dataCache.lastStateHash = currentHash;
        dataCache.processedBackupData = result;
        
        return result;
    }

    function _determineGuestBackupStatus(guest, guestSnapshots, guestTasks, dayBoundaries, threeDaysAgo, sevenDaysAgo) {
        const guestId = String(guest.vmid);
        
        // Get guest snapshots from pveBackups - use node-aware filtering
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        const allSnapshots = pveBackups.guestSnapshots || [];
        const guestSnapshotCount = allSnapshots
            .filter(snap => {
                // Match vmid
                if (parseInt(snap.vmid, 10) !== parseInt(guest.vmid, 10)) return false;
                
                // For VM/CT snapshots, match by node/endpoint if available
                if (guest.node && snap.node) {
                    return snap.node === guest.node;
                }
                if (guest.endpointId && snap.endpointId) {
                    return snap.endpointId === guest.endpointId;
                }
                
                // Fallback: include if no node info available
                return true;
            })
            .length;
        
        // Use pre-filtered data instead of filtering large arrays
        const totalBackups = guestSnapshots ? guestSnapshots.length : 0;
        const latestSnapshot = guestSnapshots && guestSnapshots.length > 0 
            ? guestSnapshots.reduce((latest, snap) => {
                return (!latest || (snap['backup-time'] && snap['backup-time'] > latest['backup-time'])) ? snap : latest;
            }, null)
            : null;
        const latestSnapshotTime = latestSnapshot ? latestSnapshot['backup-time'] : null;
        

        const latestTask = guestTasks && guestTasks.length > 0
            ? guestTasks.reduce((latest, task) => {
               return (!latest || (task.startTime && task.startTime > latest.startTime)) ? task : latest;
            }, null)
            : null;

        let healthStatus = 'none';
        let displayTimestamp = null;

        // Only use actual backup snapshots for timestamp, not just tasks
        // Tasks might be failed attempts or other operations
        if (latestSnapshotTime) {
            displayTimestamp = latestSnapshotTime;
            if (latestSnapshotTime >= threeDaysAgo) healthStatus = 'ok';
            else if (latestSnapshotTime >= sevenDaysAgo) healthStatus = 'stale';
            else healthStatus = 'old';
        } else if (latestTask && latestTask.status === 'OK') {
            // Only use task timestamp if there are no snapshots AND the task succeeded
            displayTimestamp = latestTask.startTime;
            if (latestTask.startTime >= threeDaysAgo) healthStatus = 'ok';
            else if (latestTask.startTime >= sevenDaysAgo) healthStatus = 'stale';
            else healthStatus = 'old';
        } else if (latestTask && latestTask.status !== 'OK') {
            // Failed task with no snapshots
            healthStatus = 'failed';
            displayTimestamp = null; // No successful backup timestamp
        } else {
            // No snapshots and no tasks
            healthStatus = 'none';
            displayTimestamp = null;
        }

        // Calculate recent failures by analyzing actual PBS and PVE backup tasks
        let recentFailures = 0;
        let lastFailureTime = null;
        
        // Get recent failure window (7 days)
        const now = Math.floor(Date.now() / 1000);
        const sevenDaysAgoForFailures = now - (7 * 24 * 60 * 60);
        
        
        if (guestTasks && guestTasks.length > 0) {
            // Analyze actual backup tasks for failures in the last 7 days
            const recentFailedTasks = guestTasks.filter(task => {
                // Include tasks from the last 7 days that failed
                return task.startTime >= sevenDaysAgoForFailures && 
                       task.status !== 'OK' && 
                       task.status !== null && 
                       task.status !== undefined;
            });
            
            recentFailures = recentFailedTasks.length;
            
            
            // Find the most recent failure timestamp
            if (recentFailedTasks.length > 0) {
                const latestFailedTask = recentFailedTasks.reduce((latest, task) => {
                    return (task.startTime > latest.startTime) ? task : latest;
                });
                lastFailureTime = latestFailedTask.startTime;
            }
        }
        
        // If no task-based failures found but health status indicates failure, count as 1
        if (recentFailures === 0 && healthStatus === 'failed') {
            recentFailures = 1;
            lastFailureTime = displayTimestamp;
            
        }

        // Enhanced 7-day backup status calculation with backup type tracking
        const last7DaysBackupStatus = dayBoundaries.map((day, index) => {
            let backupTypes = new Set();
            let hasFailures = false;
            let activityDetails = [];

            // Check tasks for this day - using pre-filtered guest tasks
            if (guestTasks) {
                const failedTasksOnThisDay = guestTasks.filter(task => 
                    task.startTime >= day.start && task.startTime < day.end && task.status !== 'OK'
                );
                const successfulTasksOnThisDay = guestTasks.filter(task => 
                    task.startTime >= day.start && task.startTime < day.end && task.status === 'OK'
                );

                // Track successful backup types
                successfulTasksOnThisDay.forEach(task => {
                    const source = task.source === 'pbs' ? 'PBS' : 'PVE';
                    const location = task.source === 'pbs' ? task.pbsInstanceName : 'Local';
                    backupTypes.add(task.source);
                    activityDetails.push(`✓ ${source} backup${location ? ` (${location})` : ''}`);
                });

                // Track failed backup attempts
                failedTasksOnThisDay.forEach(task => {
                    const source = task.source === 'pbs' ? 'PBS' : 'PVE';
                    const location = task.source === 'pbs' ? task.pbsInstanceName : 'Local';
                    hasFailures = true;
                    activityDetails.push(`✗ ${source} backup failed${location ? ` (${location})` : ''}`);
                });
            }

            // Check for backup storage activity (snapshots/backups created)
            if (guestSnapshots) {
                const snapshotsOnThisDay = guestSnapshots.filter(
                    snap => snap['backup-time'] >= day.start && snap['backup-time'] < day.end
                );
                
                snapshotsOnThisDay.forEach(snap => {
                    if (snap.source === 'pbs') {
                        backupTypes.add('pbs');
                        activityDetails.push(`✓ PBS backup stored (${snap.pbsInstanceName})`);
                    } else if (snap.source === 'pve') {
                        backupTypes.add('pve');
                        activityDetails.push(`✓ PVE backup stored (${snap.storage || 'Local'})`);
                    }
                });
            }

            // Check for VM/CT snapshots on this day (if we have that data)
            const pveBackups = PulseApp.state.get('pveBackups') || {};
            const allSnapshots = pveBackups.guestSnapshots || [];
            const guestDaySnapshots = allSnapshots.filter(snap => {
                // Match vmid and time
                if (parseInt(snap.vmid, 10) !== parseInt(guestId, 10)) return false;
                if (!(snap.snaptime >= day.start && snap.snaptime < day.end)) return false;
                
                // Match by node/endpoint if available
                if (guest.node && snap.node) {
                    return snap.node === guest.node;
                }
                if (guest.endpointId && snap.endpointId) {
                    return snap.endpointId === guest.endpointId;
                }
                
                // Fallback: include if no node info available
                return true;
            });
            
            if (guestDaySnapshots.length > 0) {
                backupTypes.add('snapshot');
                activityDetails.push(`✓ ${guestDaySnapshots.length} VM/CT snapshot${guestDaySnapshots.length > 1 ? 's' : ''} created`);
            }

            // Create day label for tooltip
            const dayDate = new Date(day.start * 1000);
            const dayLabel = dayDate.toLocaleDateString('en-US', { 
                weekday: 'short', 
                month: 'short', 
                day: 'numeric' 
            });

            return {
                backupTypes: Array.from(backupTypes),
                hasFailures: hasFailures,
                details: activityDetails.length > 0 ? activityDetails.join('\n') : 'No backup activity',
                date: dayLabel
            };
        });

        // Calculate separate PBS and PVE backup information
        let pbsBackupCount = 0;
        let pbsBackupInfo = '';
        let pveBackupCount = 0; 
        let pveBackupInfo = '';
        let pbsBackupAmbiguous = false; // Track if PBS backups can't be reliably attributed
        
        if (guestSnapshots && guestSnapshots.length > 0) {
            // Separate PBS and PVE snapshots
            const pbsSnapshots = guestSnapshots.filter(s => s.source === 'pbs');
            const pveSnapshots = guestSnapshots.filter(s => s.source === 'pve');
            
            // Calculate PBS backup information
            if (pbsSnapshots.length > 0) {
                pbsBackupCount = pbsSnapshots.length;
                const pbsInstances = [...new Set(pbsSnapshots.map(s => s.pbsInstanceName).filter(Boolean))];
                const datastores = [...new Set(pbsSnapshots.map(s => s.datastoreName).filter(Boolean))];
                
                // Since we're now properly filtering by owner/endpoint, we only need to check
                // if any snapshots have missing owner information
                const ambiguousSnapshots = pbsSnapshots.filter(snap => {
                    const owner = snap.owner || '';
                    return !owner || !owner.includes('!');
                });
                
                // Mark as ambiguous only if we have snapshots without owner info
                if (ambiguousSnapshots.length > 0) {
                    pbsBackupAmbiguous = true;
                }
                
                // Group backups by PBS instance and namespace for detailed info
                const backupsByPbs = {};
                pbsSnapshots.forEach(snap => {
                    if (snap.pbsInstanceName) {
                        if (!backupsByPbs[snap.pbsInstanceName]) {
                            backupsByPbs[snap.pbsInstanceName] = { count: 0, datastores: new Set(), namespaces: new Set() };
                        }
                        backupsByPbs[snap.pbsInstanceName].count++;
                        if (snap.datastoreName) {
                            backupsByPbs[snap.pbsInstanceName].datastores.add(snap.datastoreName);
                        }
                        if (snap.namespace) {
                            backupsByPbs[snap.pbsInstanceName].namespaces.add(snap.namespace);
                        }
                    }
                });
                
                if (pbsInstances.length === 1) {
                    const info = backupsByPbs[pbsInstances[0]];
                    const nsArray = Array.from(info.namespaces || []);
                    
                    // Create namespace breakdown for display
                    const namespaceBreakdown = {};
                    pbsSnapshots.forEach(snap => {
                        const ns = snap.namespace || 'root';
                        namespaceBreakdown[ns] = (namespaceBreakdown[ns] || 0) + 1;
                    });
                    
                    // Format namespace info with counts
                    let nsInfo = '';
                    const actualNamespaces = Object.keys(namespaceBreakdown);
                    if (actualNamespaces.length > 1) {
                        // This guest actually has backups in multiple namespaces
                        const nsDetails = Object.entries(namespaceBreakdown)
                            .map(([ns, count]) => `${ns === 'root' ? 'root' : ns}:${count}`)
                            .join(', ');
                        nsInfo = ` (${nsDetails})`;
                    } else if (actualNamespaces.length === 1 && actualNamespaces[0] !== 'root') {
                        // Single non-root namespace
                        nsInfo = ` (${actualNamespaces[0]})`;
                    }
                    
                    pbsBackupInfo = `${pbsInstances[0]} (${datastores.join(', ')})${nsInfo}`;
                } else if (pbsInstances.length > 1) {
                    const details = pbsInstances.map(pbs => {
                        const info = backupsByPbs[pbs];
                        const dsArray = Array.from(info.datastores);
                        const nsArray = Array.from(info.namespaces || []);
                        const nsInfo = nsArray.length > 0 ? ` [${nsArray.map(ns => ns === 'root' ? 'root' : ns).join(',')}]` : '';
                        return `${pbs}: ${info.count} on ${dsArray.join(', ')}${nsInfo}`;
                    }).join(' | ');
                    pbsBackupInfo = details;
                }
            }
            
            // Calculate PVE backup information
            if (pveSnapshots.length > 0) {
                pveBackupCount = pveSnapshots.length;
                const storages = [...new Set(pveSnapshots.map(s => s.storage).filter(Boolean))];
                
                if (storages.length === 1) {
                    pveBackupInfo = storages[0];
                } else if (storages.length > 1) {
                    pveBackupInfo = storages.join(', ');
                } else {
                    pveBackupInfo = 'Local storage';
                }
            }
        }
        
        // Include task data for counts if no snapshots but tasks exist
        if (guestTasks && guestTasks.length > 0) {
            const pbsTasks = guestTasks.filter(t => t.source === 'pbs');
            const pveTasks = guestTasks.filter(t => t.source === 'pve');
            
            if (pbsBackupCount === 0 && pbsTasks.length > 0) {
                // No PBS snapshots but have PBS tasks - show as recent activity
                const pbsInstances = [...new Set(pbsTasks.map(t => t.pbsInstanceName).filter(Boolean))];
                if (pbsInstances.length > 0) {
                    pbsBackupInfo = `Recent activity on ${pbsInstances.join(', ')}`;
                }
            }
            
            if (pveBackupCount === 0 && pveTasks.length > 0) {
                // No PVE backups but have PVE tasks - show as recent activity
                pveBackupInfo = 'Recent activity';
            }
        }

        // Calculate type-specific latest backup times
        const latestTimes = {};
        
        if (guestSnapshots && guestSnapshots.length > 0) {
            // Separate snapshots by type
            const pbsSnapshots = guestSnapshots.filter(snap => snap.source === 'pbs' || snap.pbsInstance);
            const pveSnapshots = guestSnapshots.filter(snap => snap.source === 'pve' || (!snap.source && !snap.pbsInstance));
            
            // Calculate latest PBS backup time
            if (pbsSnapshots.length > 0) {
                const latestPbs = pbsSnapshots.reduce((latest, snap) => {
                    return (!latest || (snap['backup-time'] && snap['backup-time'] > latest['backup-time'])) ? snap : latest;
                }, null);
                latestTimes.pbs = latestPbs ? latestPbs['backup-time'] : null;
            }
            
            // Calculate latest PVE backup time  
            if (pveSnapshots.length > 0) {
                const latestPve = pveSnapshots.reduce((latest, snap) => {
                    return (!latest || (snap['backup-time'] && snap['backup-time'] > latest['backup-time'])) ? snap : latest;
                }, null);
                latestTimes.pve = latestPve ? latestPve['backup-time'] : null;
            }
        }
        
        // VM/Container snapshots are tracked separately
        if (guestSnapshotCount > 0) {
            // Get latest snapshot time from VM/CT snapshots
            const vmSnapshots = allSnapshots.filter(snap => {
                if (parseInt(snap.vmid, 10) !== parseInt(guest.vmid, 10)) return false;
                if (guest.node && snap.node) return snap.node === guest.node;
                if (guest.endpointId && snap.endpointId) return snap.endpointId === guest.endpointId;
                return true;
            });
            
            if (vmSnapshots.length > 0) {
                const latestVmSnapshot = vmSnapshots.reduce((latest, snap) => {
                    const snapTime = snap.snaptime;
                    const latestTime = latest ? latest.snaptime : 0;
                    return (snapTime && snapTime > latestTime) ? snap : latest;
                }, null);
                latestTimes.snapshots = latestVmSnapshot ? latestVmSnapshot.snaptime : null;
            }
        }
        
        // Determine the most recent backup type based on latest times
        let mostRecentBackupType = null;
        let mostRecentTime = 0;
        
        if (latestTimes.pbs && latestTimes.pbs > mostRecentTime) {
            mostRecentTime = latestTimes.pbs;
            mostRecentBackupType = 'pbs';
        }
        if (latestTimes.pve && latestTimes.pve > mostRecentTime) {
            mostRecentTime = latestTimes.pve;
            mostRecentBackupType = 'pve';
        }
        if (latestTimes.snapshots && latestTimes.snapshots > mostRecentTime) {
            mostRecentTime = latestTimes.snapshots;
            mostRecentBackupType = 'snapshot';
        }
        
        return {
            guestName: guest.name || `Guest ${guest.vmid}`,
            guestId: guest.vmid,
            guestType: guest.type === 'qemu' ? 'VM' : 'LXC',
            node: guest.node,
            guestPveStatus: guest.status,
            latestBackupTime: displayTimestamp,
            latestTimes: latestTimes, // NEW: Type-specific latest times
            mostRecentBackupType: mostRecentBackupType, // NEW: Most recent backup type
            pbsBackups: pbsBackupCount,
            pbsBackupInfo: pbsBackupInfo,
            pbsBackupAmbiguous: pbsBackupAmbiguous, // NEW: Track if PBS backups are ambiguous
            pveBackups: pveBackupCount,
            pveBackupInfo: pveBackupInfo,
            totalBackups: totalBackups,
            backupHealthStatus: healthStatus,
            last7DaysBackupStatus: last7DaysBackupStatus,
            snapshotCount: guestSnapshotCount,
            recentFailures: recentFailures,
            lastFailureTime: lastFailureTime,
            endpointId: guest.endpointId
        };
    }

    function _filterBackupData(backupStatusByGuest, backupsSearchInput) {
        const currentBackupsSearchTerm = backupsSearchInput ? backupsSearchInput.value.toLowerCase() : '';
        const backupsSearchTerms = currentBackupsSearchTerm.split(',').map(term => term.trim()).filter(term => term);
        const backupsFilterHealth = PulseApp.state.get('backupsFilterHealth');
        const backupsFilterGuestType = PulseApp.state.get('backupsFilterGuestType');
        const backupsFilterBackupType = PulseApp.state.get('backupsFilterBackupType');
        const calendarDateFilter = PulseApp.state.get('calendarDateFilter');
        const showFailuresOnly = PulseApp.state.get('backupsFilterFailures') || false;

        // Debug logging for failures filter
        if (showFailuresOnly) {
            const guestsWithFailures = backupStatusByGuest.filter(item => item.recentFailures > 0);
        }

        return backupStatusByGuest.filter(item => {
            // Failures filter - show only guests with recent failures
            if (showFailuresOnly && item.recentFailures === 0) {
                return false;
            }

            const healthMatch = (backupsFilterHealth === 'all') ||
                                (backupsFilterHealth === 'ok' && (item.backupHealthStatus === 'ok' || item.backupHealthStatus === 'stale')) ||
                                (backupsFilterHealth === 'warning' && (item.backupHealthStatus === 'old')) ||
                                (backupsFilterHealth === 'none' && item.backupHealthStatus === 'none');
            if (!healthMatch) return false;

            const typeMatch = (backupsFilterGuestType === 'all') ||
                              (backupsFilterGuestType === 'vm' && item.guestType === 'VM') ||
                              (backupsFilterGuestType === 'lxc' && item.guestType === 'LXC');
            if (!typeMatch) return false;

            // Backup type filter - only show guests that have the specified backup type
            if (backupsFilterBackupType && backupsFilterBackupType !== 'all') {
                let hasBackupType = false;
                if (backupsFilterBackupType === 'pbs' && item.pbsBackups > 0) {
                    hasBackupType = true;
                } else if (backupsFilterBackupType === 'pve' && item.pveBackups > 0) {
                    hasBackupType = true;
                } else if (backupsFilterBackupType === 'snapshots' && item.snapshotCount > 0) {
                    hasBackupType = true;
                }
                if (!hasBackupType) return false;
            }

            // Calendar date selection should NOT filter the table
            // It only affects the detail card/filtered summary

            if (backupsSearchTerms.length > 0) {
                return backupsSearchTerms.some(term =>
                    (item.guestName?.toLowerCase() || '').includes(term) ||
                    (item.node?.toLowerCase() || '').includes(term) ||
                    (item.guestId?.toString() || '').includes(term)
                );
            }
            return true;
        });
    }

    function createThresholdIndicator(guestStatus) {
        // Get current app state to check for custom thresholds
        const currentState = PulseApp.state.get();
        if (!currentState || !currentState.customThresholds) {
            return ''; // No custom thresholds data available
        }
        
        // Check if this guest has custom thresholds configured
        const hasCustomThresholds = currentState.customThresholds.some(config => 
            config.endpointId === guestStatus.endpointId && 
            config.nodeId === guestStatus.node && 
            config.vmid === guestStatus.guestId &&
            config.enabled
        );
        
        if (hasCustomThresholds) {
            return `
                <span class="inline-flex items-center justify-center w-3 h-3 text-xs font-bold text-white bg-blue-500 rounded-full" 
                      title="Custom alert thresholds configured">
                    T
                </span>
            `;
        }
        
        return '';
    }

    function _renderBackupTableRow(guestStatus) {
        const row = PulseApp.ui.common.createTableRow();
        row.dataset.guestId = guestStatus.guestId;
        row.id = `backup-row-${guestStatus.guestId}`; // Add ID for row tracking

        // Check if guest has custom thresholds
        const thresholdIndicator = createThresholdIndicator(guestStatus);

        const latestBackupFormatted = guestStatus.latestBackupTime
            ? PulseApp.utils.formatPbsTimestampRelative(guestStatus.latestBackupTime)
            : '<span class="text-gray-400">No backups found</span>';

        const typeIconClass = guestStatus.guestType === 'VM'
            ? 'vm-icon bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 font-medium'
            : 'ct-icon bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 px-1.5 py-0.5 font-medium';
        const typeIcon = `<span class="type-icon inline-block rounded text-xs align-middle ${typeIconClass}">${guestStatus.guestType}</span>`;


        // Create PBS backup cell with visual indicator
        let pbsBackupCell = '';
        if (guestStatus.pbsBackups > 0) {
            const pbsIcon = '<span class="inline-block w-2 h-2 bg-purple-500 rounded-full mr-1" title="PBS Backup"></span>';
            const ambiguityIcon = guestStatus.pbsBackupAmbiguous 
                ? '<span class="inline-block ml-1 text-yellow-500 dark:text-yellow-400" title="⚠️ These PBS backups may belong to another guest with the same VMID">⚠️</span>' 
                : '';
            const pbsText = `${pbsIcon}${guestStatus.pbsBackups}${ambiguityIcon}`;
            const tooltip = guestStatus.pbsBackupInfo || '';
            const fullTooltip = guestStatus.pbsBackupAmbiguous 
                ? `${tooltip} (Warning: Backups may belong to another guest with VMID ${guestStatus.guestId})`
                : tooltip;
            pbsBackupCell = `<span class="text-purple-700 dark:text-purple-300" ${fullTooltip ? `title="${fullTooltip}"` : ''}>${pbsText}</span>`;
        } else {
            pbsBackupCell = '<span class="text-gray-400 dark:text-gray-500">0</span>';
        }

        // Create PVE backup cell with visual indicator  
        let pveBackupCell = '';
        if (guestStatus.pveBackups > 0) {
            const pveIcon = '<span class="inline-block w-2 h-2 bg-orange-500 rounded-full mr-1" title="PVE Backup"></span>';
            pveBackupCell = `<span class="text-orange-700 dark:text-orange-300" ${guestStatus.pveBackupInfo ? `title="${guestStatus.pveBackupInfo}"` : ''}>${pveIcon}${guestStatus.pveBackups}</span>`;
        } else {
            pveBackupCell = '<span class="text-gray-400 dark:text-gray-500">0</span>';
        }

        // Create snapshot button or count display
        let snapshotCell = '';
        if (guestStatus.snapshotCount > 0) {
            const snapshotIcon = '<span class="inline-block w-2 h-2 bg-yellow-500 rounded-full mr-1" title="VM/CT Snapshots"></span>';
            snapshotCell = `<button class="text-yellow-600 dark:text-yellow-400 hover:underline view-snapshots-btn" 
                data-vmid="${guestStatus.guestId}" 
                data-node="${guestStatus.node}"
                data-endpoint="${guestStatus.endpointId}"
                data-type="${guestStatus.guestType.toLowerCase()}">${snapshotIcon}${guestStatus.snapshotCount}</button>`;
        } else {
            snapshotCell = '<span class="text-gray-400 dark:text-gray-500">0</span>';
        }

        // Create failures cell
        let failuresCell = '';
        if (guestStatus.recentFailures > 0) {
            const failureTime = guestStatus.lastFailureTime 
                ? PulseApp.utils.formatPbsTimestamp(guestStatus.lastFailureTime)
                : 'Unknown';
            failuresCell = `<span class="text-red-600 dark:text-red-400 font-medium" title="Last failure: ${failureTime}">${guestStatus.recentFailures}</span>`;
        } else {
            failuresCell = '<span class="text-gray-400 dark:text-gray-500">0</span>';
        }

        // Create namespace cell
        const namespaceCell = guestStatus.pbsNamespaceText || '-';
        

        // Create sticky guest name column
        const guestNameContent = `
            <div class="flex items-center gap-1">
                <span>${guestStatus.guestName}</span>
                ${thresholdIndicator}
            </div>
        `;
        const stickyGuestCell = PulseApp.ui.common.createStickyColumn(guestNameContent, {
            title: guestStatus.guestName,
            additionalClasses: 'text-gray-900 dark:text-gray-100',
            padding: 'p-1 px-2'
        });
        row.appendChild(stickyGuestCell);
        
        // Create regular cells
        row.appendChild(PulseApp.ui.common.createTableCell(guestStatus.guestId, 'p-1 px-2 text-gray-500 dark:text-gray-400'));
        row.appendChild(PulseApp.ui.common.createTableCell(typeIcon, 'p-1 px-2'));
        row.appendChild(PulseApp.ui.common.createTableCell(guestStatus.node, 'p-1 px-2 whitespace-nowrap text-gray-500 dark:text-gray-400'));
        row.appendChild(PulseApp.ui.common.createTableCell(namespaceCell, 'p-1 px-2 whitespace-nowrap text-gray-500 dark:text-gray-400'));
        row.appendChild(PulseApp.ui.common.createTableCell(latestBackupFormatted, 'p-1 px-2 whitespace-nowrap text-gray-500 dark:text-gray-400'));
        row.appendChild(PulseApp.ui.common.createTableCell(snapshotCell, 'p-1 px-2 text-center'));
        row.appendChild(PulseApp.ui.common.createTableCell(pveBackupCell, 'p-1 px-2 text-center'));
        row.appendChild(PulseApp.ui.common.createTableCell(pbsBackupCell, 'p-1 px-2 text-center'));
        row.appendChild(PulseApp.ui.common.createTableCell(failuresCell, 'p-1 px-2 text-center'));
        return row;
    }

    function _updateBackupStatusMessages(statusTextElement, visibleCount, backupsSearchInput) {
        if (!statusTextElement) return;

        const currentBackupsSearchTerm = backupsSearchInput ? backupsSearchInput.value : '';
        const backupsFilterGuestType = PulseApp.state.get('backupsFilterGuestType');
        const backupsFilterHealth = PulseApp.state.get('backupsFilterHealth');

        const statusBaseText = `Updated: ${new Date().toLocaleTimeString()}`;
        let statusFilterText = currentBackupsSearchTerm ? ` | Filter: "${currentBackupsSearchTerm}"` : '';
        const typeFilterLabel = backupsFilterGuestType !== 'all' ? backupsFilterGuestType.toUpperCase() : '';
        const healthFilterLabel = backupsFilterHealth !== 'all' ? backupsFilterHealth.charAt(0).toUpperCase() + backupsFilterHealth.slice(1) : '';
        const otherFilters = [typeFilterLabel, healthFilterLabel].filter(Boolean).join('/');
        if (otherFilters) {
            statusFilterText += ` | ${otherFilters}`;
        }
        const statusCountText = ` | Showing ${visibleCount} guests`;
        statusTextElement.textContent = statusBaseText + statusFilterText + statusCountText;
    }

    function _initTableCalendarClick() {
        const backupsTableBody = document.getElementById('backups-overview-tbody');
        const calendarContainer = document.getElementById('backup-calendar-heatmap');
        
        if (!backupsTableBody || !calendarContainer) return;
        
        // Get current filtered guest from state (persists across API updates)
        let currentFilteredGuest = PulseApp.state.get('currentFilteredGuest') || null;
        
        // Add click listeners to table rows
        const tableRows = backupsTableBody.querySelectorAll('tr[data-guest-id]');
        
        tableRows.forEach(row => {
            const guestId = row.dataset.guestId;
            
            // Add cursor pointer to indicate clickability
            row.style.cursor = 'pointer';
            
            // Restore visual indication if this row was previously selected
            if (currentFilteredGuest === guestId) {
                row.classList.add('bg-blue-50', 'dark:bg-blue-900/20');
                // Re-apply calendar filter on restore (not a user action)
                _filterCalendarToGuest(guestId, false);
            }
            
            row.addEventListener('click', () => {
                if (currentFilteredGuest === guestId) {
                    // Clicking the same row again resets the filter
                    _resetCalendarFilter();
                    currentFilteredGuest = null;
                    PulseApp.state.set('currentFilteredGuest', null);
                    // Remove visual indication
                    tableRows.forEach(r => r.classList.remove('bg-blue-50', 'dark:bg-blue-900/20'));
                } else {
                    // Filter to this guest
                    _filterCalendarToGuest(guestId);
                    currentFilteredGuest = guestId;
                    PulseApp.state.set('currentFilteredGuest', guestId);
                    // Add visual indication
                    tableRows.forEach(r => r.classList.remove('bg-blue-50', 'dark:bg-blue-900/20'));
                    row.classList.add('bg-blue-50', 'dark:bg-blue-900/20');
                }
            });
        });
        
        // If we had a filtered guest but the row no longer exists (e.g., due to filtering), clear the state
        if (currentFilteredGuest && !document.querySelector(`tr[data-guest-id="${currentFilteredGuest}"]`)) {
            PulseApp.state.set('currentFilteredGuest', null);
            _resetCalendarFilter();
        }
    }

    function _filterCalendarToGuest(guestId, isUserAction = true) {
        // Re-render the calendar with only this guest's data
        const calendarContainer = document.getElementById('backup-calendar-heatmap');
        if (!calendarContainer || !PulseApp.ui.calendarHeatmap) return;
        
        // Get the current backup data
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        
        // Apply PBS instance filter
        const pbsInstanceFilterValue = PulseApp.state.get('backupsFilterPbsInstance') || 'all';
        const filteredPbsDataArray = pbsInstanceFilterValue === 'all'
            ? pbsDataArray
            : pbsDataArray.filter((_, index) => index.toString() === pbsInstanceFilterValue);
        
        // Get PBS snapshots
        const pbsSnapshots = filteredPbsDataArray.flatMap(pbsInstance =>
            (pbsInstance.datastores || []).flatMap(ds =>
                (ds.snapshots || []).map(snap => ({
                    ...snap,
                    pbsInstanceName: pbsInstance.pbsInstanceName,
                    datastoreName: ds.name,
                    source: 'pbs'
                }))
            )
        );
        
        // Get PVE storage backups
        const pveStorageBackups = [];
        if (pveBackups?.storageBackups && Array.isArray(pveBackups.storageBackups)) {
            pveBackups.storageBackups.forEach(backup => {
                pveStorageBackups.push({
                    'backup-time': backup.ctime,
                    backupType: _extractBackupTypeFromVolid(backup.volid, backup.vmid),
                    backupVMID: backup.vmid,
                    vmid: backup.vmid, // Ensure vmid is preserved for filtering
                    size: backup.size,
                    protected: backup.protected,
                    storage: backup.storage,
                    volid: backup.volid,
                    format: backup.format,
                    node: backup.node,
                    endpointId: backup.endpointId,
                    source: 'pve'
                });
            });
        }
        
        // Get VM snapshots
        const vmSnapshots = (pveBackups.guestSnapshots || []).map(snap => ({
            ...snap,
            source: 'vmSnapshots'
        }));
        
        // Get backup tasks
        const pbsBackupTasks = [];
        filteredPbsDataArray.forEach(pbs => {
            if (pbs.backupTasks?.recentTasks && Array.isArray(pbs.backupTasks.recentTasks)) {
                pbs.backupTasks.recentTasks.forEach(task => {
                    pbsBackupTasks.push({
                        ...task,
                        pbsInstanceName: pbs.pbsInstanceName,
                        source: 'pbs'
                    });
                });
            }
        });
        
        const pveBackupTasks = [];
        if (Array.isArray(pveBackups?.backupTasks)) {
            pveBackups.backupTasks.forEach(task => {
                pveBackupTasks.push({
                    ...task,
                    source: 'pve'
                });
            });
        }
        
        const backupData = {
            pbsSnapshots: pbsSnapshots,
            pveBackups: pveStorageBackups,
            vmSnapshots: vmSnapshots,
            backupTasks: [...pbsBackupTasks, ...pveBackupTasks]
        };
        
        // Get detail card for callback
        const detailCardContainer = document.getElementById('backup-detail-card');
        let onDateSelect = null;
        
        if (detailCardContainer && PulseApp.ui.backupDetailCard) {
            // Find existing detail card or create callback
            const existingCard = detailCardContainer.querySelector('.bg-slate-800');
            if (existingCard) {
                onDateSelect = (dateData, instant = false) => {
                    PulseApp.ui.backupDetailCard.updateBackupDetailCard(existingCard, dateData, instant);
                };
                
                // Only auto-select today on initial filter, not on API updates
                // The calendar will handle the auto-selection
            }
        }
        
        // Reset filter when filtering to specific guest
        if (PulseApp.ui.calendarHeatmap.resetFilter) {
            PulseApp.ui.calendarHeatmap.resetFilter();
        }
        
        // Create filtered calendar for this specific guest
        const filteredCalendar = PulseApp.ui.calendarHeatmap.createCalendarHeatmap(backupData, guestId, [guestId], onDateSelect, isUserAction);
        // Replace children instead of using innerHTML to avoid flash
        while (calendarContainer.firstChild) {
            calendarContainer.removeChild(calendarContainer.firstChild);
        }
        calendarContainer.appendChild(filteredCalendar);
    }
    
    function _resetCalendarFilter() {
        // Re-render the calendar with all filtered guests (respecting table filters)
        const calendarContainer = document.getElementById('backup-calendar-heatmap');
        if (!calendarContainer || !PulseApp.ui.calendarHeatmap) return;
        
        // Get current filtered backup status to determine which guests to show
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        
        // Apply PBS instance filter
        const pbsInstanceFilterValue = PulseApp.state.get('backupsFilterPbsInstance') || 'all';
        const filteredPbsDataArray = pbsInstanceFilterValue === 'all'
            ? pbsDataArray
            : pbsDataArray.filter((_, index) => index.toString() === pbsInstanceFilterValue);
        
        const allGuests = [...vmsData, ...containersData];
        const { tasksByGuest, snapshotsByGuest, dayBoundaries, threeDaysAgo, sevenDaysAgo } = _getInitialBackupData();
        const backupStatusByGuest = allGuests.map(guest => {
            // Try PBS (generic), PVE (endpoint-generic), and PVE (fully-specific) keys
            const baseKey = `${guest.vmid}-${guest.type === 'qemu' ? 'vm' : 'ct'}`;
            const endpointKey = guest.endpointId ? `-${guest.endpointId}` : '';
            const nodeKey = guest.node ? `-${guest.node}` : '';
            const endpointGenericKey = `${baseKey}${endpointKey}`;
            const fullSpecificKey = `${baseKey}${endpointKey}${nodeKey}`;
            
            // Get snapshots from all keys and combine them
            // For PBS, we need to check all PBS instances AND namespaces to find backups for this guest
            // NOTE: PBS backups are identified only by VMID, not by source node, so guests with
            // the same VMID on different nodes will show the same PBS backup count
            const pbsSnapshots = [];
            filteredPbsDataArray.forEach(pbsInstance => {
                // Get all possible namespaces from the PBS instance
                const namespaces = new Set(['root']); // Always include root
                if (pbsInstance.datastores) {
                    pbsInstance.datastores.forEach(ds => {
                        if (ds.snapshots) {
                            ds.snapshots.forEach(snap => {
                                if (snap.namespace) {
                                    namespaces.add(snap.namespace);
                                }
                            });
                        }
                    });
                }
                
                // Check all namespace keys for this guest
                namespaces.forEach(namespace => {
                    const pbsKey = `${baseKey}-${pbsInstance.pbsInstanceName}-${namespace}`;
                    const snapshots = snapshotsByGuest.get(pbsKey) || [];
                    pbsSnapshots.push(...snapshots);
                });
            });
            
            // Try multiple key variations for PVE backup matching to handle edge cases
            let pveEndpointSnapshots = snapshotsByGuest.get(endpointGenericKey) || [];
            let pveSpecificSnapshots = snapshotsByGuest.get(fullSpecificKey) || [];
            
            // Fallback: if no PVE backups found with standard keys, try alternative key formats
            if (pveEndpointSnapshots.length === 0 && pveSpecificSnapshots.length === 0) {
                // Try alternative guest type mappings in case of inconsistencies
                const altGuestType = guest.type === 'qemu' ? 'ct' : 'vm';
                const altBaseKey = `${guest.vmid}-${altGuestType}`;
                const altEndpointGenericKey = `${altBaseKey}${endpointKey}`;
                const altFullSpecificKey = `${altBaseKey}${endpointKey}${nodeKey}`;
                
                const altPveEndpointSnapshots = snapshotsByGuest.get(altEndpointGenericKey) || [];
                const altPveSpecificSnapshots = snapshotsByGuest.get(altFullSpecificKey) || [];
                
                // Use alternative keys if they have results
                if (altPveEndpointSnapshots.length > 0 || altPveSpecificSnapshots.length > 0) {
                    pveEndpointSnapshots = altPveEndpointSnapshots;
                    pveSpecificSnapshots = altPveSpecificSnapshots;
                }
            }
            
            // Deduplicate PVE snapshots by volid to avoid counting the same backup multiple times
            const pveSnapshotsMap = new Map();
            [...pveEndpointSnapshots, ...pveSpecificSnapshots].forEach(snap => {
                if (snap.volid) {
                    pveSnapshotsMap.set(snap.volid, snap);
                }
            });
            const uniquePveSnapshots = Array.from(pveSnapshotsMap.values());
            
            const allGuestSnapshots = [...pbsSnapshots, ...uniquePveSnapshots];
            
            // Similar for tasks
            const pbsTasks = tasksByGuest.get(baseKey) || [];
            const pveEndpointTasks = tasksByGuest.get(endpointGenericKey) || [];
            const pveSpecificTasks = tasksByGuest.get(fullSpecificKey) || [];
            const allGuestTasks = [...pbsTasks, ...pveEndpointTasks, ...pveSpecificTasks];
            
            return _determineGuestBackupStatus(guest, allGuestSnapshots, allGuestTasks, dayBoundaries, threeDaysAgo, sevenDaysAgo);
        });
        const filteredBackupStatus = _filterBackupData(backupStatusByGuest, backupsSearchInput);
        
        // Get the current backup data
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        
        // Prepare backup data same as in updateBackupsTab
        const pbsSnapshots = filteredPbsDataArray.flatMap(pbsInstance =>
            (pbsInstance.datastores || []).flatMap(ds =>
                (ds.snapshots || []).map(snap => ({
                    ...snap,
                    pbsInstanceName: pbsInstance.pbsInstanceName,
                    datastoreName: ds.name,
                    source: 'pbs'
                }))
            )
        );
        
        const pveStorageBackups = [];
        if (pveBackups?.storageBackups && Array.isArray(pveBackups.storageBackups)) {
            pveBackups.storageBackups.forEach(backup => {
                pveStorageBackups.push({
                    'backup-time': backup.ctime,
                    backupType: _extractBackupTypeFromVolid(backup.volid, backup.vmid),
                    backupVMID: backup.vmid,
                    vmid: backup.vmid, // Ensure vmid is preserved for filtering
                    size: backup.size,
                    protected: backup.protected,
                    storage: backup.storage,
                    volid: backup.volid,
                    format: backup.format,
                    node: backup.node,
                    endpointId: backup.endpointId,
                    source: 'pve'
                });
            });
        }
        
        const vmSnapshots = (pveBackups.guestSnapshots || []).map(snap => ({
            ...snap,
            source: 'vmSnapshots'
        }));
        
        const pbsBackupTasks = [];
        filteredPbsDataArray.forEach(pbs => {
            if (pbs.backupTasks?.recentTasks && Array.isArray(pbs.backupTasks.recentTasks)) {
                pbs.backupTasks.recentTasks.forEach(task => {
                    pbsBackupTasks.push({
                        ...task,
                        pbsInstanceName: pbs.pbsInstanceName,
                        source: 'pbs'
                    });
                });
            }
        });
        
        const pveBackupTasks = [];
        if (Array.isArray(pveBackups?.backupTasks)) {
            pveBackups.backupTasks.forEach(task => {
                pveBackupTasks.push({
                    ...task,
                    source: 'pve'
                });
            });
        }
        
        const backupData = {
            pbsSnapshots: pbsSnapshots,
            pveBackups: pveStorageBackups,
            vmSnapshots: vmSnapshots,
            backupTasks: [...pbsBackupTasks, ...pveBackupTasks]
        };
        
        // Create calendar respecting current table filters - use unique guest identifiers
        // Apply namespace filtering if active
        let guestsForIds = filteredBackupStatus;
        if (namespaceFilter !== 'all') {
            guestsForIds = filteredBackupStatus.filter(guestStatus => {
                // Only include guests that have backups in the selected namespace
                return guestStatus.totalBackups > 0;
            });
        }
        
        const filteredGuestIds = guestsForIds.map(guest => {
            // Create unique identifier including node/endpoint to handle guests with same vmid on different nodes
            const nodeIdentifier = guest.node || guest.endpointId || '';
            return nodeIdentifier ? `${guest.guestId}-${nodeIdentifier}` : guest.guestId.toString();
        });
        // Get detail card for callback
        const detailCardContainer = document.getElementById('backup-detail-card');
        let onDateSelect = null;
        
        if (detailCardContainer && PulseApp.ui.backupDetailCard) {
            // Find existing detail card or create callback
            const existingCard = detailCardContainer.querySelector('.bg-slate-800');
            if (existingCard) {
                onDateSelect = (dateData, instant = false) => {
                    PulseApp.ui.backupDetailCard.updateBackupDetailCard(existingCard, dateData, instant);
                };
                
                // Clear the detail card when resetting filter
                PulseApp.ui.backupDetailCard.updateBackupDetailCard(existingCard, null, true);
            }
        }
        
        // Reset filter when restoring full calendar view  
        if (PulseApp.ui.calendarHeatmap.resetFilter) {
            PulseApp.ui.calendarHeatmap.resetFilter();
        }
        
        const restoredCalendar = PulseApp.ui.calendarHeatmap.createCalendarHeatmap(backupData, null, filteredGuestIds, onDateSelect);
        // Replace children instead of using innerHTML to avoid flash
        while (calendarContainer.firstChild) {
            calendarContainer.removeChild(calendarContainer.firstChild);
        }
        calendarContainer.appendChild(restoredCalendar);
    }

    function checkGuestBackupForDate(backupData, guestId, dateKey) {
        const guestBackups = [];
        let hasBackups = false;
        
        // Get guest data for name lookup
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const allGuests = [...vmsData, ...containersData];
        const guest = allGuests.find(g => parseInt(g.vmid, 10) === parseInt(guestId, 10));
        
        if (!guest) return null;
        
        const guestInfo = {
            vmid: guestId,
            name: guest.name,
            type: guest.type === 'qemu' ? 'VM' : 'CT',
            types: [],
            backupCount: 0,
            node: guest.node,
            endpointId: guest.endpointId,
            // Create unique key to match table filtering logic
            uniqueKey: (guest.node || guest.endpointId) ? 
                `${guestId}-${guest.node || guest.endpointId}` : 
                guestId.toString()
        };
        
        // Check all backup sources for this guest on this date
        ['pbsSnapshots', 'pveBackups', 'vmSnapshots'].forEach(source => {
            if (!backupData[source]) return;
            
            const dayBackups = backupData[source].filter(item => {
                const timestamp = item.ctime || item.snaptime || item['backup-time'];
                if (!timestamp) return false;
                
                const date = new Date(timestamp * 1000);
                const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
                const itemDateKey = utcDate.toISOString().split('T')[0];
                
                const vmid = item.vmid || item['backup-id'] || item.backupVMID;
                if (vmid != guestId || itemDateKey !== dateKey) return false;
                
                // For PBS backups (centralized), don't filter by node
                if (source === 'pbsSnapshots') return true;
                
                // For PVE backups and snapshots (node-specific), match node/endpoint
                const itemNode = item.node;
                const itemEndpoint = item.endpointId;
                
                // Match by node if available
                if (guest.node && itemNode) {
                    return itemNode === guest.node;
                }
                
                // Match by endpointId if available
                if (guest.endpointId && itemEndpoint) {
                    return itemEndpoint === guest.endpointId;
                }
                
                // If no node/endpoint info available, include it (fallback)
                return true;
            });
            
            if (dayBackups.length > 0) {
                hasBackups = true;
                guestInfo.types.push(source);
                guestInfo.backupCount += dayBackups.length;
            }
        });
        
        if (!hasBackups) return null;
        
        // Check for failures
        let hasFailures = false;
        if (backupData.backupTasks) {
            const dayTasks = backupData.backupTasks.filter(task => {
                if (!task.starttime) return false;
                
                // Match vmid
                const taskVmid = task.vmid || task.guestId;
                if (parseInt(taskVmid, 10) !== parseInt(guestId, 10)) return false;
                
                const date = new Date(task.starttime * 1000);
                const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
                const taskDateKey = utcDate.toISOString().split('T')[0];
                
                if (taskDateKey !== dateKey || task.status === 'OK') return false;
                
                // For PBS tasks (centralized), don't filter by node
                if (task.source === 'pbs') return true;
                
                // For PVE tasks (node-specific), match node/endpoint
                const taskNode = task.node;
                const taskEndpoint = task.endpointId;
                
                // Match by node if available
                if (guest.node && taskNode) {
                    return taskNode === guest.node;
                }
                
                // Match by endpointId if available
                if (guest.endpointId && taskEndpoint) {
                    return taskEndpoint === guest.endpointId;
                }
                
                // If no node/endpoint info available, include it (fallback)
                return true;
            });
            
            hasFailures = dayTasks.length > 0;
        }
        
        guestBackups.push(guestInfo);
        
        // Count backup types for stats
        const stats = {
            totalGuests: 1,
            pbsCount: guestInfo.types.includes('pbsSnapshots') ? 1 : 0,
            pveCount: guestInfo.types.includes('pveBackups') ? 1 : 0,
            snapshotCount: guestInfo.types.includes('vmSnapshots') ? 1 : 0,
            failureCount: hasFailures ? 1 : 0
        };
        
        return {
            date: dateKey,
            backups: guestBackups,
            stats: stats
        };
    }

    function _dayHasGuestBackup(dateKey, guestId) {
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        
        const targetDate = new Date(dateKey);
        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
        const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
        const startTimestamp = Math.floor(startOfDay.getTime() / 1000);
        const endTimestamp = Math.floor(endOfDay.getTime() / 1000);
        
        // Check PBS snapshots
        const pbsSnapshots = pbsDataArray.flatMap(pbsInstance =>
            (pbsInstance.datastores || []).flatMap(ds =>
                (ds.snapshots || []).filter(snap => {
                    const vmid = snap['backup-id'];
                    const timestamp = snap['backup-time'];
                    return parseInt(vmid, 10) === parseInt(guestId, 10) && timestamp >= startTimestamp && timestamp < endTimestamp;
                })
            )
        );
        
        if (pbsSnapshots.length > 0) return true;
        
        // Check PVE storage backups
        if (pveBackups.storageBackups && Array.isArray(pveBackups.storageBackups)) {
            const matchingBackups = pveBackups.storageBackups.filter(backup => {
                return parseInt(backup.vmid, 10) === parseInt(guestId, 10) && 
                       backup.ctime >= startTimestamp && 
                       backup.ctime < endTimestamp;
            });
            if (matchingBackups.length > 0) return true;
        }
        
        // Check VM snapshots
        const vmSnapshots = (pveBackups.guestSnapshots || []).filter(snap => {
            return parseInt(snap.vmid, 10) === parseInt(guestId, 10) &&
                   snap.snaptime >= startTimestamp &&
                   snap.snaptime < endTimestamp;
        });
        
        if (vmSnapshots.length > 0) return true;
        
        return false;
    }

    function _highlightTableRows(guestIds, highlight) {
        const backupsTableBody = document.getElementById('backups-overview-tbody');
        if (!backupsTableBody) return;
        
        guestIds.forEach(guestId => {
            const row = backupsTableBody.querySelector(`tr[data-guest-id="${guestId}"]`);
            if (row) {
                if (highlight) {
                    // Apply highlighting to non-sticky cells only to avoid layout shift
                    const cells = row.querySelectorAll('td:not(.sticky)');
                    cells.forEach(cell => {
                        cell.classList.add('bg-blue-50/50', 'dark:bg-blue-900/10');
                    });
                    // Add a subtle left border to the second cell (ID column)
                    const idCell = row.querySelector('td:nth-child(2)');
                    if (idCell) {
                        idCell.classList.add('border-l-2', 'border-l-blue-400', 'dark:border-l-blue-500');
                    }
                } else {
                    const cells = row.querySelectorAll('td:not(.sticky)');
                    cells.forEach(cell => {
                        cell.classList.remove('bg-blue-50/50', 'dark:bg-blue-900/10');
                    });
                    const idCell = row.querySelector('td:nth-child(2)');
                    if (idCell) {
                        idCell.classList.remove('border-l-2', 'border-l-blue-400', 'dark:border-l-blue-500');
                    }
                }
            }
        });
    }

    function updateBackupsTab(isUserAction = false) {
        // Prevent socket updates too close to user actions
        if (!isUserAction && (Date.now() - lastUserUpdateTime < 1000)) {
            // Skip this update if it's within 1 second of a user action
            return;
        }
        
        // Prevent updates while processing date selection to avoid overwriting
        if (isProcessingDateSelection && !isUserAction) {
            return;
        }
        
        if (isUserAction) {
            lastUserUpdateTime = Date.now();
        }
        
        
        // Ensure DOM cache is initialized
        if (!domCache.tableBody) {
            _initDomCache();
        }
        
        // Use cached DOM elements
        const { tableContainer, tableBody, noDataMsg, statusTextElement, pbsSummaryElement, scrollableContainer } = domCache;
        const loadingMsg = document.getElementById('backups-loading-message'); // Not in cache yet

        if (!tableContainer || !tableBody || !loadingMsg || !noDataMsg || !statusTextElement) {
            console.error("UI elements for Backups tab not found!");
            return;
        }

        // Store current scroll position for both axes
        const currentScrollLeft = scrollableContainer.scrollLeft || 0;
        const currentScrollTop = scrollableContainer.scrollTop || 0;

        const { allGuests, initialDataReceived, tasksByGuest, snapshotsByGuest, dayBoundaries, threeDaysAgo, sevenDaysAgo } = _getInitialBackupData();

        if (!initialDataReceived) {
            // Only show loading message if the table is not already visible with data
            if (tableContainer.classList.contains('hidden') || tableBody.children.length === 0) {
                loadingMsg.classList.remove('hidden');
                tableContainer.classList.add('hidden');
                noDataMsg.classList.add('hidden');
                // Don't hide visualization section to prevent blinking
            }
            return;
        }

        if (allGuests.length === 0) {
            loadingMsg.classList.add('hidden');
            tableContainer.classList.add('hidden');
            noDataMsg.textContent = "No Proxmox guests (VMs/Containers) found.";
            noDataMsg.classList.remove('hidden');
            _updateBackupStatusMessages(statusTextElement, 0, backupsSearchInput);
            return;
        }
        loadingMsg.classList.add('hidden');

        // Debug: Log guest count
        
        // Get PBS data array early as it's needed for guest backup status calculation
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        
        // Get PBS instance filter
        const pbsInstanceFilterValue = PulseApp.state.get('backupsFilterPbsInstance') || 'all';
        
        // Filter PBS instances based on selection
        const filteredPbsDataArray = pbsInstanceFilterValue === 'all'
            ? pbsDataArray
            : pbsDataArray.filter((_, index) => index.toString() === pbsInstanceFilterValue);
        
        // Get the current namespace filter
        const namespaceFilter = PulseApp.state.get('backupsFilterNamespace') || 'all';
        
        // Get the current backup type filter
        const backupTypeFilter = PulseApp.state.get('backupsFilterBackupType') || 'all';
        
        const backupStatusByGuest = allGuests.map(guest => {
            // Try PBS (generic), PVE (endpoint-generic), and PVE (fully-specific) keys
            const baseKey = `${guest.vmid}-${guest.type === 'qemu' ? 'vm' : 'ct'}`;
            const endpointKey = guest.endpointId ? `-${guest.endpointId}` : '';
            const nodeKey = guest.node ? `-${guest.node}` : '';
            const endpointGenericKey = `${baseKey}${endpointKey}`;
            const fullSpecificKey = `${baseKey}${endpointKey}${nodeKey}`;
            
            // Get PBS snapshots and determine the specific namespace for this guest
            const pbsSnapshots = [];
            let guestNamespace = null;
            
            
            // When namespace filtering is active, we need to check if this guest actually has backups
            // in the filtered namespace, and only show that namespace if it does
            if (namespaceFilter !== 'all') {
                // Determine endpoint suffix for this guest
                const guestEndpoint = guest.endpointId || 'primary';
                let endpointSuffix = '';
                if (guestEndpoint === 'primary') {
                    endpointSuffix = '-primary';
                } else {
                    // For secondary endpoints, use the actual endpoint ID for consistency
                    endpointSuffix = `-${guestEndpoint}`;
                }
                
                // Check if this guest has backups in the filtered namespace
                let hasBackupsInFilteredNamespace = false;
                filteredPbsDataArray.forEach(pbsInstance => {
                    // Include endpoint suffix in the key to get only backups from the correct source
                    const pbsKey = `${baseKey}-${pbsInstance.pbsInstanceName}-${namespaceFilter}${endpointSuffix}`;
                    const snapshots = snapshotsByGuest.get(pbsKey) || [];
                    if (snapshots.length > 0) {
                        hasBackupsInFilteredNamespace = true;
                        pbsSnapshots.push(...snapshots);
                    }
                });
                
                // Only set the namespace if the guest actually has backups there
                if (hasBackupsInFilteredNamespace) {
                    guestNamespace = namespaceFilter;
                } else {
                    // Guest has no backups in this namespace, check all namespaces to find where it does have backups
                    let bestNamespace = null;
                    let mostRecentTime = 0;
                    
                    filteredPbsDataArray.forEach(pbsInstance => {
                        // Look through all available namespace keys for this guest
                        snapshotsByGuest.forEach((snapshots, key) => {
                            // Check if key matches pattern: vmid-type-pbsinstance-namespace-endpoint
                            if (key.startsWith(`${baseKey}-${pbsInstance.pbsInstanceName}-`) && key.endsWith(endpointSuffix)) {
                                // Extract namespace from the key
                                const parts = key.split('-');
                                const namespace = parts[parts.length - 2];
                                
                                if (snapshots.length > 0) {
                                    // Find the most recent backup time in this namespace
                                    const maxTime = Math.max(...snapshots.map(snap => 
                                        snap['backup-time'] || snap.backup_time || 0));
                                    
                                    if (maxTime > mostRecentTime) {
                                        mostRecentTime = maxTime;
                                        bestNamespace = namespace;
                                    }
                                }
                            }
                        });
                    });
                    
                    guestNamespace = bestNamespace;
                }
            } else {
                // When showing all namespaces, determine which namespace this specific guest belongs to
                // by checking if there's a PBS backup matching the guest+node combination
                // If guest has backups in multiple namespaces, use the one with the most recent backup
                let bestNamespace = null;
                let mostRecentTime = 0;
                const namespaceSnapshots = new Map(); // Store snapshots by namespace
                
                // Determine endpoint suffix for this guest
                const guestEndpoint = guest.endpointId || 'primary';
                let endpointSuffix = '';
                if (guestEndpoint === 'primary') {
                    endpointSuffix = '-primary';
                } else {
                    // For secondary endpoints, use the actual endpoint ID for consistency
                    endpointSuffix = `-${guestEndpoint}`;
                }
                
                filteredPbsDataArray.forEach(pbsInstance => {
                    // Look through all available namespace keys for this guest with the correct endpoint
                    snapshotsByGuest.forEach((snapshots, key) => {
                        // Check if key matches pattern: vmid-type-pbsinstance-namespace-endpoint
                        if (key.startsWith(`${baseKey}-${pbsInstance.pbsInstanceName}-`) && key.endsWith(endpointSuffix)) {
                            // Extract namespace from the key (it's between PBS instance and endpoint suffix)
                            const parts = key.split('-');
                            const endpointPart = parts[parts.length - 1];
                            const namespace = parts[parts.length - 2];
                            
                            // Since we're already filtering by endpoint in the key, all these snapshots belong to this guest
                            const relevantSnapshots = snapshots;
                            
                            if (relevantSnapshots.length > 0) {
                                // Store snapshots by namespace
                                if (!namespaceSnapshots.has(namespace)) {
                                    namespaceSnapshots.set(namespace, []);
                                }
                                namespaceSnapshots.get(namespace).push(...relevantSnapshots);
                                
                                // Find the most recent backup time in this namespace
                                // PBS snapshots use 'backup-time' instead of 'backup_time'
                                const maxTime = Math.max(...relevantSnapshots.map(snap => 
                                    snap['backup-time'] || snap.backup_time || 0));
                                
                                if (maxTime > mostRecentTime) {
                                    // Use the namespace with the most recent backup
                                    mostRecentTime = maxTime;
                                    bestNamespace = namespace;
                                }
                            }
                        }
                    });
                });
                
                guestNamespace = bestNamespace;
                
                
                // Only include snapshots from the determined namespace
                if (bestNamespace && namespaceSnapshots.has(bestNamespace)) {
                    pbsSnapshots.push(...namespaceSnapshots.get(bestNamespace));
                }
            }
            
            const pveEndpointSnapshots = snapshotsByGuest.get(endpointGenericKey) || [];
            const pveSpecificSnapshots = snapshotsByGuest.get(fullSpecificKey) || [];
            
            // Deduplicate PVE snapshots by volid to avoid counting the same backup multiple times
            const pveSnapshotsMap = new Map();
            [...pveEndpointSnapshots, ...pveSpecificSnapshots].forEach(snap => {
                if (snap.volid) {
                    pveSnapshotsMap.set(snap.volid, snap);
                }
            });
            const uniquePveSnapshots = Array.from(pveSnapshotsMap.values());
            
            const allGuestSnapshots = [...pbsSnapshots, ...uniquePveSnapshots];
            
            // Similar for tasks
            const pbsTasks = tasksByGuest.get(baseKey) || [];
            const pveEndpointTasks = tasksByGuest.get(endpointGenericKey) || [];
            const pveSpecificTasks = tasksByGuest.get(fullSpecificKey) || [];
            const allGuestTasks = [...pbsTasks, ...pveEndpointTasks, ...pveSpecificTasks];
            
            const guestStatus = _determineGuestBackupStatus(guest, allGuestSnapshots, allGuestTasks, dayBoundaries, threeDaysAgo, sevenDaysAgo);
            
            // Add namespace information to the guest status
            guestStatus.pbsNamespace = guestNamespace;
            guestStatus.pbsNamespaceText = guestNamespace || '-';
            
            return guestStatus;
        });
        
        // Debug: Log backup status results
        const healthStats = {
            '<24h': 0,
            '1-7d': 0,
            '7-14d': 0,
            '>14d': 0,
            'none': 0
        };
        backupStatusByGuest.forEach(status => {
            const now = Date.now() / 1000;
            if (!status.latestBackupTime) {
                healthStats.none++;
            } else {
                const ageSeconds = now - status.latestBackupTime;
                const ageDays = ageSeconds / (24 * 60 * 60);
                if (ageDays < 1) healthStats['<24h']++;
                else if (ageDays <= 7) healthStats['1-7d']++;
                else if (ageDays <= 14) healthStats['7-14d']++;
                else healthStats['>14d']++;
            }
        });
        
        const filteredBackupStatus = _filterBackupData(backupStatusByGuest, backupsSearchInput);
        
        // Create unfiltered backup status for health card
        let unfilteredBackupStatusByGuest = backupStatusByGuest;
        
        // When any namespace is selected (including 'all'), we need to show ALL guests' backup status
        // This ensures the backup health summary includes all guests, not just those with backups in the selected namespace
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const allGuestsUnfiltered = [...vmsData, ...containersData];
        
        if (namespaceFilter === 'all') {
            // When showing all namespaces, create separate backup status entries for each guest in each namespace
            
            // Get all available namespaces from PBS data
            const originalPbsDataArray = pbsDataArray; // Use the same PBS data that was used for the main backup status
            const availableNamespaces = new Set(['root']); // Always include root
            originalPbsDataArray.forEach(pbsInstance => {
                (pbsInstance.datastores || []).forEach(ds => {
                    (ds.snapshots || []).forEach(snap => {
                        availableNamespaces.add(snap.namespace || 'root');
                    });
                });
            });
            
            // Create backup status entries for each guest in each namespace where they have backups
            unfilteredBackupStatusByGuest = [];
            allGuestsUnfiltered.forEach(guest => {
                // Use the same logic as the filtered version but for all guests
                const baseKey = `${guest.vmid}-${guest.type === 'qemu' ? 'vm' : 'ct'}`;
                const endpointKey = guest.endpointId ? `-${guest.endpointId}` : '';
                const nodeKey = guest.node ? `-${guest.node}` : '';
                
                // Check each namespace to see if this guest has backups there
                availableNamespaces.forEach(namespace => {
                    // Get PBS snapshots for this guest in this specific namespace
                    const pbsSnapshots = [];
                    let hasBackupsInNamespace = false;
                    
                    originalPbsDataArray.forEach(pbsInstance => {
                        (pbsInstance.datastores || []).forEach(ds => {
                            (ds.snapshots || []).forEach(snap => {
                                const snapNamespace = snap.namespace || 'root';
                                if (snapNamespace === namespace && snap['backup-id'] == guest.vmid) {
                                    // Check if this backup belongs to this guest using owner token
                                    const owner = snap.owner || '';
                                    let ownerToken = null;
                                    if (owner && owner.includes('!')) {
                                        ownerToken = owner.split('!')[1].toLowerCase();
                                    }
                                    
                                    let isCorrectGuest = true;
                                    if (ownerToken) {
                                        const guestEndpoint = guest.endpointId || 'primary';
                                        const guestNode = guest.node;
                                        
                                        // More flexible owner token matching
                                        if (guestEndpoint === 'primary') {
                                            // For primary endpoint, check if owner token matches a secondary endpoint
                                            const secondaryEndpoints = Array.from(new Set(
                                                allGuestsUnfiltered
                                                    .filter(g => g.endpointId)
                                                    .map(g => g.endpointId.split('.')[0].toLowerCase())
                                            ));
                                            
                                            // Special case: if the guest node matches the owner token, it's likely correct
                                            // This handles cases where a node name matches the cluster name
                                            if (guestNode && guestNode.toLowerCase() === ownerToken) {
                                                isCorrectGuest = true;
                                            } else if (secondaryEndpoints.includes(ownerToken)) {
                                                // Only reject if we find a matching secondary endpoint AND this guest
                                                // doesn't belong to that endpoint's cluster
                                                const matchingSecondaryGuest = allGuestsUnfiltered.find(g => 
                                                    g.endpointId && 
                                                    g.endpointId.split('.')[0].toLowerCase() === ownerToken &&
                                                    g.vmid == guest.vmid
                                                );
                                                isCorrectGuest = !matchingSecondaryGuest;
                                            }
                                        } else {
                                            // For secondary endpoints, be more flexible with owner token matching
                                            const endpointHostname = guestEndpoint.split('.')[0].toLowerCase();
                                            
                                            // Check if owner token matches endpoint name
                                            if (ownerToken === endpointHostname) {
                                                isCorrectGuest = true;
                                            } else if (guestNode && guestNode.toLowerCase() === ownerToken) {
                                                // Special case: if the guest node matches the owner token, it's likely correct
                                                // This handles cases where backups are made with node-specific tokens
                                                isCorrectGuest = true;
                                            } else {
                                                // For secondary endpoints, also accept backups if no other guest claims them
                                                // Check if any other guest on a different endpoint has the same VMID
                                                const otherEndpointGuest = allGuestsUnfiltered.find(g => 
                                                    g.vmid == guest.vmid &&
                                                    g.endpointId !== guestEndpoint &&
                                                    g.endpointId && 
                                                    g.endpointId.split('.')[0].toLowerCase() === ownerToken
                                                );
                                                
                                                // If no other endpoint claims this backup, accept it
                                                isCorrectGuest = !otherEndpointGuest;
                                            }
                                        }
                                    }
                                    
                                    if (isCorrectGuest) {
                                        pbsSnapshots.push({
                                            ...snap,
                                            pbsInstanceName: pbsInstance.pbsInstanceName,
                                            datastoreName: ds.name,
                                            namespace: namespace,
                                            source: 'pbs'
                                        });
                                        hasBackupsInNamespace = true;
                                    }
                                }
                            });
                        });
                    });
                    
                    // Only create an entry for this guest-namespace combination if there are backups
                    if (hasBackupsInNamespace) {
                        // Get all snapshots for this guest (including PVE and VM snapshots)
                        const endpointGenericKey = `${baseKey}${endpointKey}`;
                        const fullSpecificKey = `${baseKey}${endpointKey}${nodeKey}`;
                        
                        const pveEndpointSnapshots = snapshotsByGuest.get(endpointGenericKey) || [];
                        const pveSpecificSnapshots = snapshotsByGuest.get(fullSpecificKey) || [];
                        
                        // Deduplicate PVE snapshots by volid to avoid counting the same backup multiple times
                        const pveSnapshotsMap = new Map();
                        [...pveEndpointSnapshots, ...pveSpecificSnapshots].forEach(snap => {
                            if (snap.volid) {
                                pveSnapshotsMap.set(snap.volid, snap);
                            }
                        });
                        const uniquePveSnapshots = Array.from(pveSnapshotsMap.values());
                        
                        const allGuestSnapshots = [...pbsSnapshots, ...uniquePveSnapshots];
                        
                        // Get tasks for this guest
                        const pbsTasks = tasksByGuest.get(baseKey) || [];
                        const pveEndpointTasks = tasksByGuest.get(endpointGenericKey) || [];
                        const pveSpecificTasks = tasksByGuest.get(fullSpecificKey) || [];
                        const allGuestTasks = [...pbsTasks, ...pveEndpointTasks, ...pveSpecificTasks];
                        
                        // Create backup status for this guest in this specific namespace
                        const guestStatus = _determineGuestBackupStatus(
                            guest, 
                            allGuestSnapshots,
                            allGuestTasks,
                            dayBoundaries,
                            threeDaysAgo,
                            sevenDaysAgo
                        );
                        
                        // When showing all namespaces, don't override the backup time
                        // The _determineGuestBackupStatus function already calculated the correct latest time across all backups
                        // Only override if we're filtering to a specific namespace
                        const namespaceFilter = PulseApp.state.get('backupsFilterNamespace') || 'all';
                        if (namespaceFilter !== 'all' && pbsSnapshots.length > 0) {
                            const latestPbsInNamespace = pbsSnapshots.reduce((latest, snap) => {
                                return (!latest || (snap['backup-time'] && snap['backup-time'] > latest['backup-time'])) ? snap : latest;
                            }, null);
                            if (latestPbsInNamespace) {
                                guestStatus.latestBackupTime = latestPbsInNamespace['backup-time'];
                            }
                        }
                        
                        // Add namespace information to the guest status
                        guestStatus.pbsNamespaceText = namespace;
                        
                        
                        unfilteredBackupStatusByGuest.push(guestStatus);
                    }
                });
            });
        } else {
            // When a specific namespace is selected, build unfilteredBackupStatusByGuest from ALL guests
            // This ensures the backup health summary includes all guests, not just those with backups in the namespace
            unfilteredBackupStatusByGuest = [];
            
            allGuestsUnfiltered.forEach(guest => {
                // Get all backup data for this guest across all namespaces
                const baseKey = `${guest.vmid}-${guest.type === 'qemu' ? 'vm' : 'ct'}`;
                const endpointKey = guest.endpointId ? `-${guest.endpointId}` : '';
                const nodeKey = guest.node ? `-${guest.node}` : '';
                const endpointGenericKey = `${baseKey}${endpointKey}`;
                const fullSpecificKey = `${baseKey}${endpointKey}${nodeKey}`;
                
                // Get all PBS snapshots for this guest (from all namespaces)
                const pbsSnapshots = [];
                filteredPbsDataArray.forEach(pbsInstance => {
                    // Get all possible namespaces from the PBS instance
                    const namespaces = new Set(['root']); // Always include root
                    if (pbsInstance.datastores) {
                        pbsInstance.datastores.forEach(ds => {
                            if (ds.snapshots) {
                                ds.snapshots.forEach(snap => {
                                    if (snap.namespace) {
                                        namespaces.add(snap.namespace);
                                    }
                                });
                            }
                        });
                    }
                    
                    // Check all namespace keys for this guest
                    namespaces.forEach(namespace => {
                        // Determine endpoint suffix for this guest
                        const guestEndpoint = guest.endpointId || 'primary';
                        let endpointSuffix = '';
                        if (guestEndpoint === 'primary') {
                            endpointSuffix = '-primary';
                        } else {
                            endpointSuffix = `-${guestEndpoint}`;
                        }
                        
                        const pbsKey = `${baseKey}-${pbsInstance.pbsInstanceName}-${namespace}${endpointSuffix}`;
                        const snapshots = snapshotsByGuest.get(pbsKey) || [];
                        pbsSnapshots.push(...snapshots);
                    });
                });
                
                // Get PVE snapshots
                const pveEndpointSnapshots = snapshotsByGuest.get(endpointGenericKey) || [];
                const pveSpecificSnapshots = snapshotsByGuest.get(fullSpecificKey) || [];
                
                // Deduplicate PVE snapshots by volid
                const pveSnapshotsMap = new Map();
                [...pveEndpointSnapshots, ...pveSpecificSnapshots].forEach(snap => {
                    if (snap.volid) {
                        pveSnapshotsMap.set(snap.volid, snap);
                    }
                });
                const uniquePveSnapshots = Array.from(pveSnapshotsMap.values());
                
                const allGuestSnapshots = [...pbsSnapshots, ...uniquePveSnapshots];
                
                // Get tasks for this guest
                const pbsTasks = tasksByGuest.get(baseKey) || [];
                const pveEndpointTasks = tasksByGuest.get(endpointGenericKey) || [];
                const pveSpecificTasks = tasksByGuest.get(fullSpecificKey) || [];
                const allGuestTasks = [...pbsTasks, ...pveEndpointTasks, ...pveSpecificTasks];
                
                // Create backup status for this guest (includes all backups from all namespaces)
                const guestStatus = _determineGuestBackupStatus(
                    guest, 
                    allGuestSnapshots,
                    allGuestTasks,
                    dayBoundaries,
                    threeDaysAgo,
                    sevenDaysAgo
                );
                
                unfilteredBackupStatusByGuest.push(guestStatus);
            });
        }

        // Prepare backup data for consolidated summary
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        
        // Get PBS snapshots for backup health card
        // When showing all namespaces, still respect PBS instance filter
        let pbsSnapshots;
        if (namespaceFilter === 'all') {
            // Use PBS data filtered by instance but not by namespace
            pbsSnapshots = filteredPbsDataArray.flatMap(pbsInstance =>
                (pbsInstance.datastores || []).flatMap(ds =>
                    (ds.snapshots || []).map(snap => {
                        // Determine endpoint information from owner field
                        const owner = snap.owner || '';
                        let endpointId = null;
                        let node = null;
                        
                        if (owner && owner.includes('!')) {
                            const ownerToken = owner.split('!')[1].toLowerCase();
                            
                            // Find matching guest to get endpoint/node info
                            const matchingGuest = allGuests.find(guest => {
                                if (guest.vmid != snap['backup-id']) return false;
                                
                                // For primary endpoint
                                if (!guest.endpointId || guest.endpointId === 'primary') {
                                    // Check if token matches a secondary endpoint
                                    const isSecondaryToken = allGuests.some(g => {
                                        if (!g.nodeDisplayName || !g.endpointId || g.endpointId === 'primary') return false;
                                        const clusterName = g.nodeDisplayName.split(' - ')[0].toLowerCase();
                                        return clusterName === ownerToken;
                                    });
                                    return !isSecondaryToken;
                                } else {
                                    // For secondary endpoints
                                    if (!guest.nodeDisplayName) return false;
                                    const clusterName = guest.nodeDisplayName.split(' - ')[0].toLowerCase();
                                    return ownerToken === clusterName;
                                }
                            });
                            
                            if (matchingGuest) {
                                endpointId = matchingGuest.endpointId;
                                node = matchingGuest.node;
                            }
                        }
                        
                        return {
                            ...snap,
                            pbsInstanceName: pbsInstance.pbsInstanceName,
                            datastoreName: ds.name,
                            namespace: snap.namespace || 'root',
                            source: 'pbs',
                            endpointId: endpointId,
                            node: node
                        };
                    })
                )
            );
        } else {
            // When filtering by specific namespace, only include snapshots from that namespace
            pbsSnapshots = filteredPbsDataArray.flatMap(pbsInstance =>
                (pbsInstance.datastores || []).flatMap(ds =>
                    (ds.snapshots || [])
                        .filter(snap => (snap.namespace || 'root') === namespaceFilter)
                        .map(snap => {
                            // Determine endpoint information from owner field
                            const owner = snap.owner || '';
                            let endpointId = null;
                            let node = null;
                            
                            if (owner && owner.includes('!')) {
                                const ownerToken = owner.split('!')[1].toLowerCase();
                                
                                // Find matching guest to get endpoint/node info
                                const matchingGuest = backupStatusByGuest.find(guest => {
                                    if (guest.guestId != snap['backup-id']) return false;
                                    
                                    // For primary endpoint
                                    if (!guest.endpointId || guest.endpointId === 'primary') {
                                        // Check if token matches a secondary endpoint
                                        const isSecondaryToken = backupStatusByGuest.some(g => {
                                            if (!g.nodeDisplayName || !g.endpointId || g.endpointId === 'primary') return false;
                                            const clusterName = g.nodeDisplayName.split(' - ')[0].toLowerCase();
                                            return clusterName === ownerToken;
                                        });
                                        return !isSecondaryToken;
                                    } else {
                                        // For secondary endpoints
                                        if (!guest.nodeDisplayName) return false;
                                        const clusterName = guest.nodeDisplayName.split(' - ')[0].toLowerCase();
                                        return ownerToken === clusterName;
                                    }
                                });
                                
                                if (matchingGuest) {
                                    endpointId = matchingGuest.endpointId;
                                    node = matchingGuest.node;
                                }
                            }
                            
                            return {
                                ...snap,
                                pbsInstanceName: pbsInstance.pbsInstanceName,
                                datastoreName: ds.name,
                                namespace: snap.namespace || 'root',
                                source: 'pbs',
                                endpointId: endpointId,
                                node: node
                            };
                        })
                )
            );
        }
        
        // Get PVE storage backups
        const pveStorageBackups = [];
        if (pveBackups?.storageBackups && Array.isArray(pveBackups.storageBackups)) {
            pveBackups.storageBackups.forEach(backup => {
                pveStorageBackups.push({
                    'backup-time': backup.ctime,
                    backupType: _extractBackupTypeFromVolid(backup.volid, backup.vmid),
                    backupVMID: backup.vmid,
                    vmid: backup.vmid, // Ensure vmid is preserved for filtering
                    size: backup.size,
                    protected: backup.protected,
                    storage: backup.storage,
                    volid: backup.volid,
                    format: backup.format,
                    node: backup.node,
                    endpointId: backup.endpointId,
                    source: 'pve'
                });
            });
        }
        
        // Get VM snapshots
        const vmSnapshots = (pveBackups.guestSnapshots || []).map(snap => ({
            ...snap,
            source: 'vmSnapshots'
        }));
        
        const backupData = {
            pbsSnapshots: pbsSnapshots,
            pveBackups: pveStorageBackups,
            vmSnapshots: vmSnapshots
        };


        // Hide node backup cards - no longer needed with consolidated view
        const nodeBackupCards = document.getElementById('node-backup-cards');
        if (nodeBackupCards) {
            nodeBackupCards.classList.add('hidden');
        }

        // Display backup calendar visualization section
        const visualizationSection = document.getElementById('backup-visualization-section');
        const summaryCardsContainer = document.getElementById('backup-summary-cards-container');
        const calendarContainer = document.getElementById('backup-calendar-heatmap');
        
        
        if (visualizationSection && backupStatusByGuest.length > 0) {
            // Hide the summary cards container - we're using consolidated summary now
            if (summaryCardsContainer) {
                summaryCardsContainer.classList.add('hidden');
            }
            
            // Get backup tasks for calendar
            const pbsBackupTasks = [];
            filteredPbsDataArray.forEach(pbs => {
                if (pbs.backupTasks?.recentTasks && Array.isArray(pbs.backupTasks.recentTasks)) {
                    pbs.backupTasks.recentTasks.forEach(task => {
                        pbsBackupTasks.push({
                            ...task,
                            pbsInstanceName: pbs.pbsInstanceName,
                            source: 'pbs'
                        });
                    });
                }
            });
            
            const pveBackupTasks = [];
            if (Array.isArray(pveBackups?.backupTasks)) {
                pveBackups.backupTasks.forEach(task => {
                    pveBackupTasks.push({
                        ...task,
                        source: 'pve'
                    });
                });
            }
            
            // Extend backupData with tasks for calendar
            const extendedBackupData = {
                ...backupData,
                backupTasks: [...pbsBackupTasks, ...pveBackupTasks]
            };
            
            // Create and display calendar heatmap with detail card
            if (calendarContainer && PulseApp.ui.calendarHeatmap && PulseApp.ui.backupDetailCard) {
                // For calendar, we want to show ALL guests with any backups
                // The namespace filter should only affect which PBS backups are shown, not hide PVE/snapshot backups
                let guestsForCalendar = filteredBackupStatus;
                
                // Get all guest IDs that have any type of backup for calendar
                // Don't filter by namespace here - let the calendar handle namespace filtering for PBS only
                const filteredGuestIds = backupStatusByGuest
                    .filter(guest => guest.totalBackups > 0)  // Any guest with backups
                    .map(guest => {
                        // Create unique identifier including node/endpoint to handle guests with same vmid on different nodes
                        const nodeIdentifier = guest.node || guest.endpointId || '';
                        return nodeIdentifier ? `${guest.guestId}-${nodeIdentifier}` : guest.guestId.toString();
                    });
                
                
                // Get detail card container
                const detailCardContainer = document.getElementById('backup-detail-card');
                let detailCard = detailCardContainer.querySelector('.bg-slate-800');
                
                // Find the detail card with the correct class
                detailCard = detailCardContainer.querySelector('.bg-white.dark\\:bg-gray-800');
                
                // Create detail card only if it doesn't exist
                let isInitialRender = false;
                if (detailCardContainer && !detailCard) {
                    isInitialRender = true;
                    // Don't show empty state if we already have data to display
                    const initialData = guestsForCalendar.length > 0 ? 
                        _prepareMultiDateDetailData(guestsForCalendar, extendedBackupData) : null;
                    detailCard = PulseApp.ui.backupDetailCard.createBackupDetailCard(initialData);
                    // Replace children instead of using innerHTML to avoid flash
                    while (detailCardContainer.firstChild) {
                        detailCardContainer.removeChild(detailCardContainer.firstChild);
                    }
                    detailCardContainer.appendChild(detailCard);
                }
                
                // Update detail card with filtered data if no calendar date is selected
                const calendarDateFilter = PulseApp.state.get('calendarDateFilter');
                // Don't update if we have a selected date to avoid overwriting the date-specific view
                if (!calendarDateFilter) {
                    // Check if any filters are actually active (excluding namespace filter)
                    // Namespace filter alone should not trigger filtered view since we want to show all guests
                    const hasActiveFilters = (
                        (backupsSearchInput && backupsSearchInput.value) ||
                        (PulseApp.state.get('backupsFilterGuestType') !== 'all') ||
                        (PulseApp.state.get('backupsFilterHealth') !== 'all') ||
                        (PulseApp.state.get('backupsFilterBackupType') !== 'all') ||
                        PulseApp.state.get('backupsFilterFailures')
                    );
                    
                    // Use unfiltered data when only namespace filter is active
                    // This ensures backup health summary shows all guests regardless of namespace
                    const dataToUse = hasActiveFilters ? guestsForCalendar : unfilteredBackupStatusByGuest;
                    
                    
                    if (dataToUse.length > 0) {
                        const multiDateData = _prepareMultiDateDetailData(dataToUse, extendedBackupData);
                        // Always use instant updates to prevent any blinking
                        PulseApp.ui.backupDetailCard.updateBackupDetailCard(detailCard, multiDateData, true);
                    } else {
                        PulseApp.ui.backupDetailCard.updateBackupDetailCard(detailCard, null, true);
                    }
                }
                
                // Track if we have a selected date to prevent overwrites
                let currentSelectedDate = null;
                
                // Create calendar with date selection callback
                const onDateSelect = (dateData, instant = false) => {
                    if (detailCard && PulseApp.ui.backupDetailCard) {
                        if (dateData) {
                            currentSelectedDate = dateData.date;
                            
                            // Instead of using raw calendar data, get guests from our namespace-aware data
                            const selectedDate = dateData.date;
                            const guestsOnDate = [];
                            
                            // Find all guests that have backups on this date from our filtered data
                            guestsForCalendar.forEach(guestStatus => {
                                // Check if this guest has backups on the selected date
                                const hasBackupOnDate = _guestHasBackupOnDate(guestStatus, selectedDate, extendedBackupData);
                                
                                if (hasBackupOnDate) {
                                    // Include the namespace-aware guest data
                                    guestsOnDate.push({
                                        vmid: guestStatus.guestId,
                                        name: guestStatus.guestName,
                                        type: guestStatus.guestType,
                                        node: guestStatus.node,
                                        namespace: guestStatus.pbsNamespace || 'root',
                                        namespaces: guestStatus.pbsNamespace ? [guestStatus.pbsNamespace] : ['root'],
                                        pbsBackupInfo: guestStatus.pbsBackupInfo,
                                        types: hasBackupOnDate.types,
                                        backupCount: hasBackupOnDate.count
                                    });
                                }
                            });
                            
                            // Create enhanced date data with namespace info
                            const enhancedDateData = {
                                date: selectedDate,
                                backups: guestsOnDate,
                                stats: {
                                    totalGuests: guestsOnDate.length,
                                    pbsCount: guestsOnDate.filter(g => g.types.includes('pbsSnapshots')).length,
                                    pveCount: guestsOnDate.filter(g => g.types.includes('pveBackups')).length,
                                    snapshotCount: guestsOnDate.filter(g => g.types.includes('vmSnapshots')).length,
                                    failureCount: 0
                                },
                                isCalendarFiltered: true,
                                namespaceFilter: namespaceFilter
                            };
                            
                            
                            // Update immediately with instant flag
                            PulseApp.ui.backupDetailCard.updateBackupDetailCard(detailCard, enhancedDateData, true);
                        } else {
                            currentSelectedDate = null;
                            
                            // No date selected, show multi-date data
                            // Check if any filters are actually active (excluding namespace filter)
                            // Namespace filter alone should not trigger filtered view since we want to show all guests
                            const hasActiveFilters = (
                                (backupsSearchInput && backupsSearchInput.value) ||
                                (PulseApp.state.get('backupsFilterGuestType') !== 'all') ||
                                (PulseApp.state.get('backupsFilterHealth') !== 'all') ||
                                (PulseApp.state.get('backupsFilterBackupType') !== 'all') ||
                                PulseApp.state.get('backupsFilterFailures')
                            );
                            
                            // Use unfiltered data when only namespace filter is active
                            // This ensures backup health summary shows all guests regardless of namespace
                            const dataToUse = hasActiveFilters ? guestsForCalendar : unfilteredBackupStatusByGuest;
                            
                            if (dataToUse.length > 0) {
                                const multiDateData = _prepareMultiDateDetailData(dataToUse, extendedBackupData);
                                PulseApp.ui.backupDetailCard.updateBackupDetailCard(detailCard, multiDateData, !isUserAction || instant);
                            } else {
                                PulseApp.ui.backupDetailCard.updateBackupDetailCard(detailCard, null, !isUserAction || instant);
                            }
                        }
                    }
                    
                    // Calendar date selection only affects the detail card, not the table
                    // No need to refresh the table when calendar date is selected
                };
                
                // Only recreate calendar if it doesn't exist
                const existingCalendar = calendarContainer.querySelector('.calendar-heatmap-container');
                if (!existingCalendar) {
                    
                    const calendarHeatmap = PulseApp.ui.calendarHeatmap.createCalendarHeatmap(
                        extendedBackupData, 
                        null, 
                        filteredGuestIds, 
                        onDateSelect,
                        isUserAction
                    );
                    // Store current namespace and backup type filters on the calendar element
                    calendarHeatmap.setAttribute('data-namespace-filter', namespaceFilter);
                    calendarHeatmap.setAttribute('data-backup-type-filter', backupTypeFilter);
                    
                    // Replace children instead of using innerHTML to avoid flash
                    while (calendarContainer.firstChild) {
                        calendarContainer.removeChild(calendarContainer.firstChild);
                    }
                    calendarContainer.appendChild(calendarHeatmap);
                } else {
                    // Track the previous namespace and backup type filters to detect changes
                    const currentCalendar = calendarContainer.querySelector('.calendar-heatmap-container');
                    const previousNamespace = currentCalendar?.getAttribute('data-namespace-filter');
                    const previousBackupType = currentCalendar?.getAttribute('data-backup-type-filter');
                    const namespaceChanged = previousNamespace !== undefined && previousNamespace !== namespaceFilter;
                    const backupTypeChanged = previousBackupType !== undefined && previousBackupType !== backupTypeFilter;
                    
                    if ((namespaceChanged || backupTypeChanged) && isUserAction) {
                        // Namespace or backup type filter changed - need to recreate calendar
                        const calendarHeatmap = PulseApp.ui.calendarHeatmap.createCalendarHeatmap(
                            extendedBackupData, 
                            null, 
                            filteredGuestIds, 
                            onDateSelect,
                            isUserAction
                        );
                        // Store current namespace and backup type filters on the calendar element
                        calendarHeatmap.setAttribute('data-namespace-filter', namespaceFilter);
                        calendarHeatmap.setAttribute('data-backup-type-filter', backupTypeFilter);
                        
                        while (calendarContainer.firstChild) {
                            calendarContainer.removeChild(calendarContainer.firstChild);
                        }
                        calendarContainer.appendChild(calendarHeatmap);
                    } else {
                        // Update existing calendar data without recreation for API updates
                        PulseApp.ui.calendarHeatmap.updateCalendarData(extendedBackupData, null, filteredGuestIds, onDateSelect);
                    }
                }
            }
            
            // Show visualization section immediately to prevent blinking
            visualizationSection.classList.remove('hidden');
        } else if (visualizationSection) {
            // Instead of hiding, show an empty state message
            if (calendarContainer) {
                // Clear and add empty state
                while (calendarContainer.firstChild) {
                    calendarContainer.removeChild(calendarContainer.firstChild);
                }
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'text-center py-8 text-gray-500 dark:text-gray-400';
                emptyDiv.textContent = 'No backup data available';
                calendarContainer.appendChild(emptyDiv);
            }
            const emptyDetailCardContainer = document.getElementById('backup-detail-card');
            if (emptyDetailCardContainer) {
                // Clear and add empty state
                while (emptyDetailCardContainer.firstChild) {
                    emptyDetailCardContainer.removeChild(emptyDetailCardContainer.firstChild);
                }
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'text-center py-8 text-gray-500 dark:text-gray-400';
                emptyDiv.textContent = 'No backup details to display';
                emptyDetailCardContainer.appendChild(emptyDiv);
            }
        }

        // Calculate PBS instances summary - only show if multiple PBS instances
        const pbsSummaryDismissed = PulseApp.state.get('pbsSummaryDismissed') || false;
        
        if (pbsSummaryElement) {
            if (pbsDataArray.length > 1 && !pbsSummaryDismissed) {
                const pbsSummary = pbsDataArray.map(pbs => {
                    const backupCount = (pbs.datastores || []).reduce((total, ds) => 
                        total + (ds.snapshots ? ds.snapshots.length : 0), 0);
                    return `${pbs.pbsInstanceName}: ${backupCount} backups`;
                }).join(' | ');
                
                pbsSummaryElement.innerHTML = `
                    <div class="flex justify-between items-center">
                        <div>
                            <strong>PBS Instances (${pbsDataArray.length}):</strong> ${pbsSummary}
                            <span class="text-gray-500 dark:text-gray-400 ml-2">• Showing aggregated backup data from all instances</span>
                        </div>
                        <button id="dismiss-pbs-summary" class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 ml-4" title="Dismiss">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                `;
                pbsSummaryElement.classList.remove('hidden');
                
                // Add dismiss handler
                const dismissBtn = document.getElementById('dismiss-pbs-summary');
                if (dismissBtn) {
                    dismissBtn.addEventListener('click', () => {
                        pbsSummaryElement.classList.add('hidden');
                        PulseApp.state.set('pbsSummaryDismissed', true);
                        PulseApp.state.saveFilterState();
                    });
                }
            } else {
                pbsSummaryElement.classList.add('hidden');
            }
        }

        // Filter by namespace - only show guests that have backups in the selected namespace
        let namespaceFilteredStatus = filteredBackupStatus;
        if (namespaceFilter !== 'all') {
            namespaceFilteredStatus = filteredBackupStatus.filter(guestStatus => {
                // When a specific namespace is selected, only show guests that have backups
                // The backup processing already filtered to only include backups from the selected namespace
                // So if a guest has any backups at all, they belong in this namespace
                return guestStatus.totalBackups > 0;
            });
        }

        const sortStateBackups = PulseApp.state.getSortState('backups');
        const sortedBackupStatus = PulseApp.utils.sortData(namespaceFilteredStatus, sortStateBackups.column, sortStateBackups.direction, 'backups');

        // Calculate dynamic column widths for responsive display
        if (sortedBackupStatus.length > 0) {
            let maxNameLength = 0;
            let maxNodeLength = 0;
            let maxPbsLength = 0;
            let maxDsLength = 0;
            
            sortedBackupStatus.forEach(status => {
                const nameLength = (status.guestName || '').length;
                const nodeLength = (status.node || '').length;
                const pbsLength = (status.pbsInstanceName || 'N/A').length;
                const dsLength = (status.datastoreName || 'N/A').length;
                
                if (nameLength > maxNameLength) maxNameLength = nameLength;
                if (nodeLength > maxNodeLength) maxNodeLength = nodeLength;
                if (pbsLength > maxPbsLength) maxPbsLength = pbsLength;
                if (dsLength > maxDsLength) maxDsLength = dsLength;
            });
            
            // Set CSS variables for column widths with responsive limits
            const nameColWidth = Math.min(Math.max(maxNameLength * 7 + 12, 80), 250);
            const nodeColWidth = Math.max(maxNodeLength * 7 + 12, 60);
            const pbsColWidth = Math.min(Math.max(maxPbsLength * 7 + 12, 80), 150);
            const dsColWidth = Math.min(Math.max(maxDsLength * 7 + 12, 80), 150);
            
            const htmlElement = document.documentElement;
            if (htmlElement) {
                htmlElement.style.setProperty('--backup-name-col-width', `${nameColWidth}px`);
                htmlElement.style.setProperty('--backup-node-col-width', `${nodeColWidth}px`);
                htmlElement.style.setProperty('--backup-pbs-col-width', `${pbsColWidth}px`);
                htmlElement.style.setProperty('--backup-ds-col-width', `${dsColWidth}px`);
            }
        }

        PulseApp.utils.preserveScrollPosition(scrollableContainer, () => {
            // Use DocumentFragment for batch DOM insertion
            if (sortedBackupStatus.length > 0) {
                const fragment = document.createDocumentFragment();
                
                // Clear existing rows and row tracker
                while (tableBody.firstChild) {
                    tableBody.removeChild(tableBody.firstChild);
                }
                rowTracker.clear();
                
                // Build all rows in fragment
                sortedBackupStatus.forEach(guestStatus => {
                    const row = _renderBackupTableRow(guestStatus);
                    // Track row for future updates
                    const guestId = `${guestStatus.guestType}-${guestStatus.guestId}`;
                    rowTracker.set(guestId, row);
                    fragment.appendChild(row);
                });
                
                // Single DOM insertion
                tableBody.appendChild(fragment);
                noDataMsg.classList.add('hidden');
                tableContainer.classList.remove('hidden');
                
                // Initialize fixed table line for mobile
                _initTableFixedLine();
            } else {
            tableContainer.classList.add('hidden');
            let emptyMessage = "No backup information found for any guests.";
             if (backupStatusByGuest.length > 0 && filteredBackupStatus.length === 0) { // Data exists, but filters hide all
                const currentBackupsSearchTerm = backupsSearchInput ? backupsSearchInput.value : '';
                const backupsFilterGuestType = PulseApp.state.get('backupsFilterGuestType');
                const typeFilterText = backupsFilterGuestType === 'all' ? '' : `Type: ${backupsFilterGuestType.toUpperCase()}`;
                const filtersApplied = [typeFilterText].filter(Boolean).join(', ');

                if (currentBackupsSearchTerm) {
                    emptyMessage = `No guests found matching search "${currentBackupsSearchTerm}"`;
                    if (filtersApplied) emptyMessage += ` and filters (${filtersApplied})`;
                } else if (filtersApplied) {
                    emptyMessage = `No guests found matching the selected filters (${filtersApplied}).`;
                } else {
                     emptyMessage = "No guests with backup information found matching current filters.";
                }
            }
            noDataMsg.textContent = emptyMessage;
            noDataMsg.classList.remove('hidden');
        }
        }); // End of preserveScrollPosition
        
        // Setup click filtering between table and calendar (only on user actions or initial load)
        if (isUserAction || !document.querySelector('#backups-overview-tbody tr[data-guest-id]')) {
            _initTableCalendarClick();
        }
        
        // Additional scroll position restoration for horizontal scrolling
        if (scrollableContainer && (currentScrollLeft > 0 || currentScrollTop > 0)) {
            requestAnimationFrame(() => {
                scrollableContainer.scrollLeft = currentScrollLeft;
                scrollableContainer.scrollTop = currentScrollTop;
            });
        }

        const backupsSortColumn = sortStateBackups.column;
        const backupsHeader = document.querySelector(`#backups-overview-table th[data-sort="${backupsSortColumn}"]`);
        if (PulseApp.ui && PulseApp.ui.common) {
             PulseApp.ui.common.updateSortUI('backups-overview-table', backupsHeader);
        } else {
            console.warn('[Backups] PulseApp.ui.common not available for updateSortUI');
        }
        _updateBackupStatusMessages(statusTextElement, sortedBackupStatus.length, backupsSearchInput);
    }

    function resetBackupsView() {
        if (backupsSearchInput) backupsSearchInput.value = '';
        PulseApp.state.set('backupsSearchTerm', '');

        const backupTypeAllRadio = document.getElementById('backups-filter-type-all');
        if(backupTypeAllRadio) backupTypeAllRadio.checked = true;
        PulseApp.state.set('backupsFilterGuestType', 'all');

        const backupStatusAllRadio = document.getElementById('backups-filter-status-all');
        if(backupStatusAllRadio) backupStatusAllRadio.checked = true;
        PulseApp.state.set('backupsFilterHealth', 'all');

        const backupBackupTypeAllRadio = document.getElementById('backups-filter-backup-all');
        if(backupBackupTypeAllRadio) backupBackupTypeAllRadio.checked = true;
        PulseApp.state.set('backupsFilterBackupType', 'all');

        const failuresFilter = document.getElementById('backups-filter-failures');
        if(failuresFilter) failuresFilter.checked = false;
        PulseApp.state.set('backupsFilterFailures', false);
        
        // Reset PBS instance filter
        if (pbsInstanceFilter) pbsInstanceFilter.value = 'all';
        PulseApp.state.set('backupsFilterPbsInstance', 'all');
        
        // Reset namespace filter
        if (namespaceFilter) namespaceFilter.value = 'all';
        PulseApp.state.set('backupsFilterNamespace', 'all');

        PulseApp.state.setSortState('backups', 'latestBackupTime', 'desc');

        // Clear calendar filter selection
        PulseApp.state.set('currentFilteredGuest', null);
        
        // Clear calendar date filter
        PulseApp.state.set('calendarDateFilter', null);
        
        // Clear calendar selection if possible
        if (PulseApp.ui.calendarHeatmap && PulseApp.ui.calendarHeatmap.clearSelection) {
            PulseApp.ui.calendarHeatmap.clearSelection();
        }

        updateBackupsTab(true); // Mark as user action
        PulseApp.state.saveFilterState(); // Save reset state
    }

    function _initSnapshotModal() {
        const modal = document.getElementById('snapshot-modal');
        const modalClose = document.getElementById('snapshot-modal-close');
        const modalBody = document.getElementById('snapshot-modal-body');
        const modalTitle = document.getElementById('snapshot-modal-title');
        
        if (!modal || !modalClose || !modalBody) {
            console.warn('[Backups] Snapshot modal elements not found');
            return;
        }
        
        // Close modal on click outside or close button
        modalClose.addEventListener('click', () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        });
        
        // Handle snapshot button clicks
        document.addEventListener('click', (e) => {
            const button = e.target.closest('.view-snapshots-btn');
            if (button) {
                const vmid = button.dataset.vmid;
                const node = button.dataset.node;
                const endpoint = button.dataset.endpoint;
                const type = button.dataset.type;
                
                _showSnapshotModal(vmid, node, endpoint, type);
            }
        });
    }
    
    function _showSnapshotModal(vmid, node, endpoint, type) {
        const modal = document.getElementById('snapshot-modal');
        const modalBody = document.getElementById('snapshot-modal-body');
        const modalTitle = document.getElementById('snapshot-modal-title');
        
        if (!modal || !modalBody || !modalTitle) return;
        
        // Get guest info
        const vmsData = PulseApp.state.get('vmsData') || [];
        const containersData = PulseApp.state.get('containersData') || [];
        const guest = [...vmsData, ...containersData].find(g => g.vmid === vmid);
        const guestName = guest?.name || `Guest ${vmid}`;
        
        modalTitle.textContent = `Snapshots for ${guestName} (${type.toUpperCase()} ${vmid})`;
        modalBody.innerHTML = '<p class="text-gray-500 dark:text-gray-400">Loading snapshots...</p>';
        
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        // Get snapshots from state
        const pveBackups = PulseApp.state.get('pveBackups') || {};
        const snapshots = (pveBackups.guestSnapshots || [])
            .filter(snap => parseInt(snap.vmid, 10) === parseInt(vmid, 10))
            .sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
        
        if (snapshots.length === 0) {
            modalBody.innerHTML = '<p class="text-gray-500 dark:text-gray-400">No snapshots found for this guest.</p>';
            return;
        }
        
        // Build snapshot table
        let html = `
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead class="bg-gray-50 dark:bg-gray-700">
                        <tr>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Created</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Description</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">RAM</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
        `;
        
        snapshots.forEach(snap => {
            const created = snap.snaptime 
                ? new Date(snap.snaptime * 1000).toLocaleString()
                : 'Unknown';
            const hasRam = snap.vmstate ? 'Yes' : 'No';
            const description = snap.description || '-';
            
            html += `
                <tr>
                    <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">${snap.name}</td>
                    <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${created}</td>
                    <td class="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">${description}</td>
                    <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">${hasRam}</td>
                </tr>
            `;
        });
        
        html += `
                    </tbody>
                </table>
            </div>
        `;
        
        modalBody.innerHTML = html;
    }
    
    
    function _guestHasBackupOnDate(guestStatus, dateString, backupData) {
        const guestId = guestStatus.guestId.toString();
        const types = [];
        let count = 0;
        
        // Check PBS snapshots
        if (guestStatus.pbsBackups > 0 && backupData.pbsSnapshots) {
            backupData.pbsSnapshots.forEach(snap => {
                const snapId = snap['backup-id'] || snap.backupVMID;
                if (parseInt(snapId, 10) === parseInt(guestId, 10)) {
                    const timestamp = snap['backup-time'];
                    if (timestamp) {
                        const snapDate = new Date(timestamp * 1000);
                        const snapDateStr = snapDate.toISOString().split('T')[0];
                        if (snapDateStr === dateString) {
                            if (!types.includes('pbsSnapshots')) types.push('pbsSnapshots');
                            count++;
                        }
                    }
                }
            });
        }
        
        // Check PVE backups
        if (guestStatus.pveBackups > 0 && backupData.pveBackups) {
            backupData.pveBackups.forEach(backup => {
                if (parseInt(backup.vmid, 10) === parseInt(guestId, 10)) {
                    const timestamp = backup.ctime || backup['backup-time'];
                    if (timestamp) {
                        const backupDate = new Date(timestamp * 1000);
                        const backupDateStr = backupDate.toISOString().split('T')[0];
                        if (backupDateStr === dateString) {
                            if (!types.includes('pveBackups')) types.push('pveBackups');
                            count++;
                        }
                    }
                }
            });
        }
        
        // Check VM snapshots
        if (guestStatus.snapshotCount > 0 && backupData.vmSnapshots) {
            backupData.vmSnapshots.forEach(snap => {
                if (parseInt(snap.vmid, 10) === parseInt(guestId, 10)) {
                    const timestamp = snap.snaptime;
                    if (timestamp) {
                        const snapDate = new Date(timestamp * 1000);
                        const snapDateStr = snapDate.toISOString().split('T')[0];
                        if (snapDateStr === dateString) {
                            if (!types.includes('vmSnapshots')) types.push('vmSnapshots');
                            count++;
                        }
                    }
                }
            });
        }
        
        return count > 0 ? { types, count } : null;
    }

    function _prepareMultiDateDetailData(filteredBackupStatus, backupData) {
        // Prepare data for multi-date detail view
        const multiDateBackups = [];
        const stats = {
            totalGuests: filteredBackupStatus.length,
            totalBackups: 0,
            pbsCount: 0,
            pveCount: 0,
            snapshotCount: 0,
            failureCount: 0
        };
        
        // Get current backup type filter to determine which dates to include
        const backupTypeFilter = PulseApp.state.get('backupsFilterBackupType') || 'all';
        
        // Get all backup data for filtered guests
        filteredBackupStatus.forEach(guestStatus => {
            const guestId = guestStatus.guestId.toString();
            const backupDates = [];
            
            // Check PBS snapshots (only if filter allows PBS backups)
            if ((backupTypeFilter === 'all' || backupTypeFilter === 'pbs') && backupData.pbsSnapshots) {
                const pbsDates = {};
                backupData.pbsSnapshots.forEach(snap => {
                    const snapId = snap['backup-id'] || snap.backupVMID;
                    
                    // Match by VMID AND node to prevent cross-endpoint contamination
                    if (parseInt(snapId, 10) === parseInt(guestId, 10)) {
                        // Check if this backup belongs to this guest using owner token
                        const owner = snap.owner || '';
                        let ownerToken = null;
                        if (owner && owner.includes('!')) {
                            ownerToken = owner.split('!')[1].toLowerCase();
                        }
                        
                        let isCorrectGuest = true;
                        if (ownerToken && guestStatus.endpointId) {
                            // For secondary endpoints, owner token should match endpoint name
                            const endpointHostname = guestStatus.endpointId.split('.')[0].toLowerCase();
                            isCorrectGuest = (ownerToken === endpointHostname);
                        } else if (ownerToken && !guestStatus.endpointId) {
                            // For primary endpoint, more flexible owner token matching
                            const guestNode = guestStatus.node;
                            
                            // Special case: if the guest node matches the owner token, it's likely correct
                            if (guestNode && guestNode.toLowerCase() === ownerToken) {
                                isCorrectGuest = true;
                            } else {
                                // Check if owner token matches a secondary endpoint
                                const allGuests = PulseApp.state.get('vms').concat(PulseApp.state.get('containers'));
                                const allEndpointIds = [...new Set(allGuests
                                    .filter(g => g.endpointId)
                                    .map(g => g.endpointId.split('.')[0].toLowerCase()))];
                                
                                if (allEndpointIds.includes(ownerToken)) {
                                    // Only reject if we find a matching secondary endpoint AND this guest
                                    // doesn't belong to that endpoint's cluster
                                    const matchingSecondaryGuest = allGuests.find(g => 
                                        g.endpointId && 
                                        g.endpointId.split('.')[0].toLowerCase() === ownerToken &&
                                        g.vmid == guestStatus.guestId
                                    );
                                    isCorrectGuest = !matchingSecondaryGuest;
                                }
                            }
                        }
                        
                        if (isCorrectGuest) {
                            const timestamp = snap['backup-time'];
                            if (timestamp) {
                                const date = new Date(timestamp * 1000);
                                const dateKey = date.toISOString().split('T')[0];
                                if (!pbsDates[dateKey]) {
                                    pbsDates[dateKey] = { types: new Set(), count: 0, latestTimestamp: timestamp };
                                } else {
                                    // Keep the latest timestamp for this date
                                    if (timestamp > pbsDates[dateKey].latestTimestamp) {
                                        pbsDates[dateKey].latestTimestamp = timestamp;
                                    }
                                }
                                pbsDates[dateKey].types.add('pbsSnapshots');
                                pbsDates[dateKey].count++;
                                stats.totalBackups++;
                            }
                        }
                    }
                });
                Object.entries(pbsDates).forEach(([date, info]) => {
                    backupDates.push({ date, types: Array.from(info.types), count: info.count, latestTimestamp: info.latestTimestamp });
                });
            }
            
            // Check PVE backups (only if filter allows PVE backups)
            if ((backupTypeFilter === 'all' || backupTypeFilter === 'pve') && backupData.pveBackups) {
                const pveDates = {};
                backupData.pveBackups.forEach(backup => {
                    if (parseInt(backup.vmid, 10) === parseInt(guestId, 10)) {
                        const timestamp = backup['backup-time'] || backup.ctime;
                        if (timestamp) {
                            const date = new Date(timestamp * 1000);
                            const dateKey = date.toISOString().split('T')[0];
                            if (!pveDates[dateKey]) {
                                pveDates[dateKey] = { types: new Set(), count: 0, latestTimestamp: timestamp };
                            } else {
                                // Keep the latest timestamp for this date
                                if (timestamp > pveDates[dateKey].latestTimestamp) {
                                    pveDates[dateKey].latestTimestamp = timestamp;
                                }
                            }
                            pveDates[dateKey].types.add('pveBackups');
                            pveDates[dateKey].count++;
                            stats.totalBackups++;
                        }
                    }
                });
                Object.entries(pveDates).forEach(([date, info]) => {
                    const existing = backupDates.find(d => d.date === date);
                    if (existing) {
                        existing.types = [...new Set([...existing.types, ...Array.from(info.types)])];
                        existing.count += info.count;
                        // Keep the latest timestamp across all backup types for this date
                        if (info.latestTimestamp > existing.latestTimestamp) {
                            existing.latestTimestamp = info.latestTimestamp;
                        }
                    } else {
                        backupDates.push({ date, types: Array.from(info.types), count: info.count, latestTimestamp: info.latestTimestamp });
                    }
                });
            }
            
            // Check VM snapshots (only if filter allows snapshots)
            if ((backupTypeFilter === 'all' || backupTypeFilter === 'snapshots') && backupData.vmSnapshots) {
                const snapDates = {};
                backupData.vmSnapshots.forEach(snap => {
                    if (parseInt(snap.vmid, 10) === parseInt(guestId, 10)) {
                        const timestamp = snap.snaptime;
                        if (timestamp) {
                            const date = new Date(timestamp * 1000);
                            const dateKey = date.toISOString().split('T')[0];
                            if (!snapDates[dateKey]) {
                                snapDates[dateKey] = { types: new Set(), count: 0, latestTimestamp: timestamp };
                            } else {
                                // Keep the latest timestamp for this date
                                if (timestamp > snapDates[dateKey].latestTimestamp) {
                                    snapDates[dateKey].latestTimestamp = timestamp;
                                }
                            }
                            snapDates[dateKey].types.add('vmSnapshots');
                            snapDates[dateKey].count++;
                            stats.totalBackups++;
                        }
                    }
                });
                Object.entries(snapDates).forEach(([date, info]) => {
                    const existing = backupDates.find(d => d.date === date);
                    if (existing) {
                        existing.types = [...new Set([...existing.types, ...Array.from(info.types)])];
                        existing.count += info.count;
                        // Keep the latest timestamp across all backup types for this date
                        if (info.latestTimestamp > existing.latestTimestamp) {
                            existing.latestTimestamp = info.latestTimestamp;
                        }
                    } else {
                        backupDates.push({ date, types: Array.from(info.types), count: info.count, latestTimestamp: info.latestTimestamp });
                    }
                });
            }
            
            // Update stats
            if (guestStatus.pbsBackups > 0) stats.pbsCount++;
            if (guestStatus.pveBackups > 0) stats.pveCount++;
            if (guestStatus.snapshotCount > 0) stats.snapshotCount++;
            if (guestStatus.recentFailures > 0) stats.failureCount++;
            
            if (backupDates.length > 0) {
                multiDateBackups.push({
                    ...guestStatus,
                    backupDates: backupDates.sort((a, b) => b.latestTimestamp - a.latestTimestamp)
                });
            } else {
                // Even if no backup dates found in detail data, include guest if they have backups
                // This is important for namespace filtering where historical data might be limited
                if (guestStatus.pbsBackups > 0 || guestStatus.pveBackups > 0 || guestStatus.snapshotCount > 0) {
                    multiDateBackups.push({
                        ...guestStatus,
                        backupDates: []
                    });
                }
            }
        });
        
        // Sort by most recent backup to see which ones will appear in "Recent"
        const sortedByRecent = multiDateBackups
            .filter(g => g.backupDates && g.backupDates.length > 0)
            .sort((a, b) => {
                const latestTimestampA = a.backupDates[0].latestTimestamp;
                const latestTimestampB = b.backupDates[0].latestTimestamp;
                return latestTimestampB - latestTimestampA;
            });

        // Get current filter info
        const filterInfo = {
            search: backupsSearchInput ? backupsSearchInput.value : '',
            guestType: PulseApp.state.get('backupsFilterGuestType'),
            backupType: backupTypeFilter,
            healthStatus: PulseApp.state.get('backupsFilterHealth'),
            failuresOnly: PulseApp.state.get('backupsFilterFailures') || false
        };
        
        // Recalculate stats based on unique guests with backups
        // Use composite key (guestId-node) to handle guests with same VMID on different nodes
        const uniqueGuestsWithPBS = new Set();
        const uniqueGuestsWithPVE = new Set();
        const uniqueGuestsWithSnapshots = new Set();
        
        multiDateBackups.forEach(guest => {
            // Create unique identifier that includes both guest ID and node/endpoint
            const uniqueKey = `${guest.guestId}-${guest.node || guest.endpointId || 'unknown'}`;
            
            // Count guests based on whether they have backup dates of the filtered type
            // This ensures we count all guests that appear in the filtered view, not just recent activity
            if (backupTypeFilter === 'all') {
                // When showing all types, use the guest's overall backup counts
                if (guest.pbsBackups > 0) uniqueGuestsWithPBS.add(uniqueKey);
                if (guest.pveBackups > 0) uniqueGuestsWithPVE.add(uniqueKey);
                if (guest.snapshotCount > 0) uniqueGuestsWithSnapshots.add(uniqueKey);
            } else {
                // When filtering by specific type, count guests who have that type in their backup dates
                // OR if they have no backup dates but have backups of that type (important for namespace filtering)
                const hasFilteredBackupType = guest.backupDates && guest.backupDates.length > 0 ?
                    guest.backupDates.some(dateInfo => {
                        if (backupTypeFilter === 'pbs') return dateInfo.types.includes('pbsSnapshots');
                        if (backupTypeFilter === 'pve') return dateInfo.types.includes('pveBackups');
                        if (backupTypeFilter === 'snapshots') return dateInfo.types.includes('vmSnapshots');
                        return false;
                    }) :
                    // Fallback to guest backup counts if no dates available
                    (backupTypeFilter === 'pbs' && guest.pbsBackups > 0) ||
                    (backupTypeFilter === 'pve' && guest.pveBackups > 0) ||
                    (backupTypeFilter === 'snapshots' && guest.snapshotCount > 0);
                
                if (hasFilteredBackupType) {
                    if (backupTypeFilter === 'pbs') uniqueGuestsWithPBS.add(uniqueKey);
                    if (backupTypeFilter === 'pve') uniqueGuestsWithPVE.add(uniqueKey);
                    if (backupTypeFilter === 'snapshots') uniqueGuestsWithSnapshots.add(uniqueKey);
                }
            }
        });
        
        stats.pbsCount = uniqueGuestsWithPBS.size;
        stats.pveCount = uniqueGuestsWithPVE.size;
        stats.snapshotCount = uniqueGuestsWithSnapshots.size;
        
        // Calculate unique dates for filtered view
        const uniqueDates = new Set();
        multiDateBackups.forEach(guest => {
            guest.backupDates.forEach(dateInfo => {
                uniqueDates.add(dateInfo.date);
            });
        });
        stats.uniqueDates = uniqueDates.size;
        
        return {
            isMultiDate: true,
            backups: multiDateBackups,
            stats: stats,
            filterInfo: filterInfo
        };
    }

    function _initNamespaceFilter() {
        namespaceFilter = document.getElementById('backups-filter-namespace');
        const filterGroup = document.getElementById('pbs-namespace-filter-group');
        
        if (!namespaceFilter || !filterGroup) return;
        
        // Add change listener
        namespaceFilter.addEventListener('change', () => {
            PulseApp.state.set('backupsFilterNamespace', namespaceFilter.value);
            // Clear calendar cache when namespace changes
            if (PulseApp.ui.calendarHeatmap && PulseApp.ui.calendarHeatmap.clearCache) {
                PulseApp.ui.calendarHeatmap.clearCache();
            }
            updateBackupsTab(true);
        });
        
        // Update namespace options when PBS data changes
        // Note: Using state change tracking instead of eventBus
        const originalPbsData = PulseApp.state.get('pbsDataArray');
        let lastPbsDataLength = originalPbsData ? originalPbsData.length : 0;
        
        // Check for PBS data changes periodically
        const checkPbsDataChanges = () => {
            const currentPbsData = PulseApp.state.get('pbsDataArray');
            const currentLength = currentPbsData ? currentPbsData.length : 0;
            if (currentLength !== lastPbsDataLength) {
                lastPbsDataLength = currentLength;
                _updateNamespaceOptions();
            }
        };
        
        // Check for changes every 2 seconds
        setInterval(checkPbsDataChanges, 2000);
        
        // Initial update
        _updateNamespaceOptions();
    }
    
    function _updateNamespaceOptions() {
        if (!namespaceFilter) return;
        
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        const selectedPbsInstance = pbsInstanceFilter ? pbsInstanceFilter.value : 'all';
        const namespaces = new Set(['root']); // Always include root
        
        // Collect namespaces from PBS data based on selected instance
        const instancesToCheck = selectedPbsInstance === 'all' 
            ? pbsDataArray 
            : pbsDataArray.filter((_, index) => index.toString() === selectedPbsInstance);
            
        instancesToCheck.forEach(pbsInstance => {
            if (pbsInstance.datastores) {
                pbsInstance.datastores.forEach(ds => {
                    if (ds.snapshots) {
                        ds.snapshots.forEach(snap => {
                            namespaces.add(snap.namespace || 'root');
                        });
                    }
                });
            }
        });
        
        // Update options
        const currentValue = namespaceFilter.value || 'all';
        namespaceFilter.innerHTML = '<option value="all">All Namespaces</option>';
        
        Array.from(namespaces).sort().forEach(ns => {
            const option = document.createElement('option');
            option.value = ns;
            option.textContent = ns === 'root' ? 'Root Namespace' : `${ns} Namespace`;
            namespaceFilter.appendChild(option);
        });
        
        // Restore selection if it still exists
        if (Array.from(namespaceFilter.options).some(opt => opt.value === currentValue)) {
            namespaceFilter.value = currentValue;
        } else {
            namespaceFilter.value = 'all';
        }
        
        // Show/hide filter based on PBS being available and having multiple namespaces
        const filterGroup = document.getElementById('pbs-namespace-filter-group');
        if (filterGroup) {
            const hasMultipleNamespaces = namespaces.size > 1;
            const hasPBS = instancesToCheck.length > 0;
            filterGroup.style.display = hasPBS && hasMultipleNamespaces ? '' : 'none';
        }
    }
    
    function _initPbsInstanceFilter() {
        pbsInstanceFilter = document.getElementById('backups-filter-pbs-instance');
        const filterGroup = document.getElementById('pbs-instance-filter-group');
        
        if (!pbsInstanceFilter || !filterGroup) return;
        
        // Add change listener
        pbsInstanceFilter.addEventListener('change', () => {
            PulseApp.state.set('backupsFilterPbsInstance', pbsInstanceFilter.value);
            // Update namespace options based on selected instance
            _updateNamespaceOptions();
            updateBackupsTab(true);
        });
        
        // Update PBS instance options when PBS data changes
        const originalPbsData = PulseApp.state.get('pbsDataArray');
        let lastPbsDataLength = originalPbsData ? originalPbsData.length : 0;
        
        // Check for PBS data changes periodically
        const checkPbsDataChanges = () => {
            const currentPbsData = PulseApp.state.get('pbsDataArray');
            const currentLength = currentPbsData ? currentPbsData.length : 0;
            if (currentLength !== lastPbsDataLength) {
                lastPbsDataLength = currentLength;
                _updatePbsInstanceOptions();
            }
        };
        
        // Check for changes every 2 seconds
        setInterval(checkPbsDataChanges, 2000);
        
        // Initial update
        _updatePbsInstanceOptions();
    }
    
    function _updatePbsInstanceOptions() {
        if (!pbsInstanceFilter) return;
        
        const pbsDataArray = PulseApp.state.get('pbsDataArray') || [];
        
        // Update options
        const currentValue = pbsInstanceFilter.value || 'all';
        pbsInstanceFilter.innerHTML = '<option value="all">All PBS Instances</option>';
        
        pbsDataArray.forEach((pbsInstance, index) => {
            const option = document.createElement('option');
            option.value = index.toString();
            option.textContent = pbsInstance.pbsInstanceName || `PBS Instance ${index + 1}`;
            pbsInstanceFilter.appendChild(option);
        });
        
        // Restore selection
        pbsInstanceFilter.value = currentValue;
        
        // Show/hide filter based on multiple PBS instances
        const filterGroup = document.getElementById('pbs-instance-filter-group');
        if (filterGroup) {
            const hasMultiplePBS = pbsDataArray.length > 1;
            filterGroup.style.display = hasMultiplePBS ? '' : 'none';
        }
    }

    // Debug function for console
    window.debugBackups = function() {
        const state = PulseApp.state;
        const pveBackups = state.get('pveBackups');
        const pbsData = state.get('pbsData');
        
        console.log('=== BACKUP DEBUG INFO ===');
        console.log('Current Date:', new Date().toISOString());
        console.log('Filters:', {
            namespace: state.get('backupsFilterNamespace'),
            backupType: state.get('backupsFilterBackupType')
        });
        
        if (pveBackups && pveBackups.storageBackups) {
            const backups = pveBackups.storageBackups;
            console.log('\nPVE Backups:', backups.length);
            
            // Look for June 7th
            const june7 = backups.filter(b => {
                const d = new Date(b.ctime * 1000);
                return d.getMonth() === 5 && d.getDate() === 7;
            });
            
            if (june7.length > 0) {
                console.log('\n🎯 June 7th backups found:');
                june7.forEach(b => {
                    const d = new Date(b.ctime * 1000);
                    console.log(`VMID ${b.vmid}: ${d.toISOString()} (Year: ${d.getFullYear()})`);
                });
            }
            
            // Recent backups
            console.log('\nMost recent 3:');
            backups.sort((a,b) => b.ctime - a.ctime).slice(0,3).forEach(b => {
                const d = new Date(b.ctime * 1000);
                console.log(`VMID ${b.vmid}: ${d.toISOString()}`);
            });
        }
        
        // Check calendar
        const currentMonth = document.querySelector('.calendar-month-container h3');
        console.log('\nCalendar showing:', currentMonth ? currentMonth.textContent : 'Not found');
        
        const june7Cell = document.querySelector('[data-date="2024-06-07"]');
        if (june7Cell) {
            console.log('June 7 2024 cell:', {
                found: true,
                highlighted: june7Cell.classList.contains('bg-orange-500'),
                classes: june7Cell.className
            });
        } else {
            console.log('June 7 2024 cell: Not in current view');
        }
        
        return 'Debug complete - check console output';
    };
    
    return {
        init,
        updateBackupsTab,
        resetBackupsView,
        _highlightTableRows
    };
})();
