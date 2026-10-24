const INITIAL_LOCATION = [34.7818, 32.0853];
let mapillaryOffline = true;
let mapillaryAccessToken = '';
let mapillarySearchRadiusMeters = 1000;

async function loadMapillaryConfig() {
    const response = await fetch('/api/config');
    if (!response.ok) {
        throw new Error(`Could not load map configuration (${response.status}): ${await response.text()}`);
    }
    const config = await response.json();
    if (typeof config.mapillaryOffline !== 'boolean') {
        throw new Error('The local configuration does not include a valid mapillaryOffline setting.');
    }
    mapillaryOffline = config.mapillaryOffline;
    if (
        typeof config.searchRadiusMeters !== 'number' ||
        !Number.isFinite(config.searchRadiusMeters) ||
        config.searchRadiusMeters <= 0
    ) {
        throw new Error('The local configuration does not include a valid panorama search radius.');
    }
    mapillarySearchRadiusMeters = config.searchRadiusMeters;
    if (typeof config.mapillaryAccessToken === 'string') {
        mapillaryAccessToken = config.mapillaryAccessToken.trim();
    }
}

function setMapillaryStatus(message, isError = false) {
    const panel = document.getElementById('mapillary');
    if (!panel) return;

    if (panel.querySelector('.mapillary-status')) {
        panel.querySelector('.mapillary-status').remove();
    }

    const status = document.createElement('div');
    status.className = 'mapillary-status';
    status.textContent = message;
    status.style.position = 'absolute';
    status.style.inset = '0';
    status.style.display = 'flex';
    status.style.alignItems = 'center';
    status.style.justifyContent = 'center';
    status.style.padding = '20px';
    status.style.background = isError ? '#1d1d1d' : '#111';
    status.style.color = '#fff';
    status.style.fontSize = '16px';
    status.style.lineHeight = '1.5';
    status.style.textAlign = 'center';
    status.style.zIndex = '30';
    status.style.pointerEvents = 'none';

    panel.appendChild(status);
}

function showPanoramaToast(message, duration = 3000) {
    const panel = document.getElementById('mapillary');
    if (!panel) return;

    panel.querySelector('.mapillary-status')?.remove();
    const status = document.createElement('div');
    status.className = 'mapillary-status';
    status.textContent = message;
    Object.assign(status.style, {
        position: 'absolute',
        top: '60px',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100% - 32px)',
        padding: '10px 14px',
        borderRadius: '6px',
        background: 'rgba(29, 29, 29, 0.9)',
        color: '#fff',
        fontSize: '14px',
        lineHeight: '1.4',
        textAlign: 'center',
        zIndex: '30',
        pointerEvents: 'none'
    });
    panel.appendChild(status);
    if (duration > 0) {
        window.setTimeout(() => status.remove(), duration);
    }
}

async function loadNearestImage(lng, lat) {
    if (!mapillaryOffline) {
        return loadNearestOnlineImage(lng, lat);
    }
    if (!window.offlinePanoramaViewer) return null;
    document.dispatchEvent(new Event('offline-panorama-selecting'));
    setMapillaryStatus('Searching local offline panoramas...');
    try {
        const params = new URLSearchParams({ lng: String(lng), lat: String(lat) });
        const response = await fetch(`/api/offline/nearest?${params}`);
        if (response.status === 404) {
            const details = await response.json();
            setMapillaryStatus(
                `${details.error || 'No downloaded panoramas found near this location.'} Show panorama points and choose a local image to start navigation.`,
                true
            );
            return null;
        }
        if (!response.ok) {
            throw new Error(`Local panorama search failed (${response.status}): ${await response.text()}`);
        }
        const nearestImage = await response.json();
        await window.offlinePanoramaViewer.loadImage(nearestImage);
        window.offlinePanoramaViewer.setBaseBearing(nearestImage.compass_angle);
        setPanoramaAttribution(nearestImage);
        document.dispatchEvent(new CustomEvent('offline-panorama-loaded', { detail: nearestImage }));
        const statusNode = document.querySelector('#mapillary .mapillary-status');
        if (statusNode) statusNode.remove();
        return nearestImage;
    } catch (error) {
        console.error('Error loading local offline panorama:', error);
        setMapillaryStatus('Could not load offline panoramas. Check the local catalog and browser console.', true);
        return null;
    }
}

async function loadNearestOnlineImage(lng, lat) {
    if (!window.mapillaryViewer) return null;
    setMapillaryStatus('Searching online Mapillary imagery...');
    try {
        const latitudeDelta = mapillarySearchRadiusMeters / 111320;
        const longitudeDelta = mapillarySearchRadiusMeters /
            (111320 * Math.cos(lat * Math.PI / 180));
        const params = new URLSearchParams({
            access_token: mapillaryAccessToken,
            fields: 'id,geometry,compass_angle,captured_at',
            bbox: [
                lng - longitudeDelta,
                lat - latitudeDelta,
                lng + longitudeDelta,
                lat + latitudeDelta
            ].join(','),
            limit: '100'
        });
        const response = await fetch(`https://graph.mapillary.com/images?${params}`);
        if (!response.ok) {
            throw new Error(`Mapillary search failed (${response.status}): ${await response.text()}`);
        }
        const result = await response.json();
        const nearest = (result.data || [])
            .filter(image => Array.isArray(image.geometry?.coordinates) && image.geometry.coordinates.length === 2)
            .map(image => {
                const [longitude, latitude] = image.geometry.coordinates;
                const dx = (longitude - lng) * 111320 * Math.cos(lat * Math.PI / 180);
                const dy = (latitude - lat) * 111320;
                return { image, distance: Math.hypot(dx, dy) };
            })
            .filter(candidate => candidate.distance <= mapillarySearchRadiusMeters)
            .sort((first, second) => first.distance - second.distance)[0]?.image;
        if (!nearest) {
            setMapillaryStatus(
                `No online Mapillary images found within ${mapillarySearchRadiusMeters} meters.`,
                true
            );
            return null;
        }

        await window.mapillaryViewer.moveTo(nearest.id);
        const [longitude, latitude] = nearest.geometry.coordinates;
        document.dispatchEvent(new CustomEvent('mapillary-online-image-selected', {
            detail: {
                id: nearest.id,
                longitude,
                latitude,
                compass_angle: nearest.compass_angle,
                captured_at: nearest.captured_at,
                attribution_url: `https://www.mapillary.com/app/?pKey=${nearest.id}&focus=photo`
            }
        }));
        const statusNode = document.querySelector('#mapillary .mapillary-status');
        if (statusNode) statusNode.remove();
        return nearest;
    } catch (error) {
        console.error('Error loading online Mapillary imagery:', error);
        setMapillaryStatus('Could not load online Mapillary imagery. Check the access token and browser console.', true);
        return null;
    }
}

function setPanoramaAttribution(image) {
    const attribution = document.getElementById('panorama-attribution');
    attribution.replaceChildren();
    if (image.creator_username) {
        attribution.append(`${image.creator_username} · `);
    }
    const link = document.createElement('a');
    link.href = image.attribution_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Mapillary · CC BY-SA';
    attribution.append(link);
}

function setPanoramaMetadata(image) {
    const metadata = document.getElementById('panorama-metadata');
    const details = [];
    const capturedAt = Number(image.captured_at);
    if (image.captured_at !== null && image.captured_at !== undefined && Number.isFinite(capturedAt)) {
        details.push(new Intl.DateTimeFormat('he-IL', {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(new Date(capturedAt)));
    }
    if (image.sequence_length > 1 && image.sequence_position > 0) {
        details.push(`תמונה ${image.sequence_position} מתוך ${image.sequence_length}`);
    }
    metadata.textContent = details.join(' · ');
    metadata.hidden = details.length === 0;
}

async function initMap() {
    try {
        await loadMapillaryConfig();
        document.body.classList.toggle('mapillary-online-mode', !mapillaryOffline);
    } catch (error) {
        console.error('Mapillary configuration error:', error);
        setMapillaryStatus(error.message, true);
    }

    maplibregl.setRTLTextPlugin(
        '/web/js/mapbox-gl-rtl-text.js',
        null,
        true
    );

    const map = new maplibregl.Map({
        container: 'map',
        style: 'http://localhost:8080/styles/osm-bright/style.json',
        center: INITIAL_LOCATION,
        zoom: 14,
        pitch: 60,
        bearing: -20
    });

    let mapReady = false;
    let currentImage;
    let directionMarker;
    let directionMarkerAdded = false;
    let liveCameraMode = false;
    let panoramaResizeObserver;
    let onlineDirectionUpdatePending = false;
    let panoramaPointsLoaded = false;
    let navigationHistory = [];
    let navigationHistoryIndex = -1;

    const resizePanoramaViewer = () => {
        if (mapillaryOffline) {
            window.offlinePanoramaViewer?.resize();
        } else {
            window.mapillaryViewer?.resize();
        }
    };

    const updatePointerDirection = bearing => {
        if (!mapillaryOffline) {
            if (!window.mapillaryViewer || !directionMarker || onlineDirectionUpdatePending) return;
            onlineDirectionUpdatePending = true;
            window.mapillaryViewer.getPointOfView()
                .then(pointOfView => {
                    if (Number.isFinite(pointOfView?.bearing)) {
                        directionMarker.setRotation(pointOfView.bearing);
                    }
                })
                .catch(error => {
                    console.error('Could not sync the direction marker with the Mapillary camera:', error);
                })
                .finally(() => {
                    onlineDirectionUpdatePending = false;
                });
            return;
        }
        if (directionMarker && Number.isFinite(bearing)) {
            directionMarker.setRotation(bearing);
        }
    };

    const updateMapillaryMarker = (image, centerMap = false) => {
        if (!mapReady || !image) return;
        currentImage = image;
        const coordinates = [image.longitude, image.latitude];

        if (!directionMarker) {
            const markerElement = document.createElement('button');
            markerElement.type = 'button';
            markerElement.className = 'mapillary-direction-marker';
            markerElement.title = 'Current offline panorama and direction';
            markerElement.setAttribute('aria-label', 'Current offline panorama and direction');
            markerElement.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true">' +
                '<path d="M24 2 43 43 24 34 5 43 24 2Z" fill="#ff7900" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
                '<circle cx="24" cy="28" r="5" fill="#fff"/>' +
                '</svg>';
            markerElement.addEventListener('click', event => {
                event.stopPropagation();
                if (currentImage && !mapillaryOffline && window.mapillaryViewer) {
                    window.mapillaryViewer.moveTo(currentImage.id).catch(error => {
                        console.error('Could not reopen the current Mapillary image:', error);
                    });
                } else if (currentImage && window.offlinePanoramaViewer) {
                    window.offlinePanoramaViewer.loadImage(currentImage).catch(error => {
                        console.error('Could not reopen the current offline panorama:', error);
                    });
                }
            });

            directionMarker = new maplibregl.Marker({
                element: markerElement,
                anchor: 'center',
                rotationAlignment: 'map',
                pitchAlignment: 'map'
            });
        }

        directionMarker
            .setLngLat(coordinates)
            .setRotation(Number.isFinite(image.compass_angle) ? image.compass_angle : 0);
        if (!directionMarkerAdded) {
            directionMarker.addTo(map);
            directionMarkerAdded = true;
        }
        if (centerMap) map.easeTo({ center: coordinates, duration: 350 });
        updatePointerDirection(window.offlinePanoramaViewer?.getBearing());
    };

    document.addEventListener('offline-panorama-loaded', event => {
        currentImage = event.detail;
        setPanoramaMetadata(currentImage);
        const existingIndex = navigationHistory.findIndex(image => image.id === currentImage.id);
        if (existingIndex >= 0) {
            navigationHistoryIndex = existingIndex;
        } else {
            navigationHistory = navigationHistory.slice(0, navigationHistoryIndex + 1);
            navigationHistory.push(currentImage);
            navigationHistoryIndex = navigationHistory.length - 1;
        }
        updateNavigationControls(currentImage);
        updateMapillaryMarker(event.detail, true);
    });

    document.addEventListener('mapillary-online-image-selected', event => {
        currentImage = event.detail;
        setPanoramaAttribution(currentImage);
        setPanoramaMetadata(currentImage);
        updateMapillaryMarker(currentImage, true);
    });

    const loadOnlineImageDetails = async imageId => {
        const params = new URLSearchParams({
            access_token: mapillaryAccessToken,
            fields: 'id,geometry,compass_angle,captured_at'
        });
        const response = await fetch(`https://graph.mapillary.com/${encodeURIComponent(imageId)}?${params}`);
        if (!response.ok) {
            throw new Error(`Mapillary image lookup failed (${response.status}): ${await response.text()}`);
        }
        const image = await response.json();
        const coordinates = image.geometry?.coordinates;
        if (
            !Array.isArray(coordinates) ||
            coordinates.length !== 2 ||
            !coordinates.every(Number.isFinite)
        ) {
            throw new Error(`Mapillary image ${imageId} did not include valid coordinates.`);
        }
        return {
            id: image.id,
            longitude: coordinates[0],
            latitude: coordinates[1],
            compass_angle: image.compass_angle,
            captured_at: image.captured_at,
            attribution_url: `https://www.mapillary.com/app/?pKey=${image.id}&focus=photo`
        };
    };

    const handleOnlineImageChange = async event => {
        try {
            const image = await loadOnlineImageDetails(event.image.id);
            currentImage = image;
            setPanoramaAttribution(image);
            setPanoramaMetadata(image);
            updateMapillaryMarker(image, true);
            const statusNode = document.querySelector('#mapillary .mapillary-status');
            if (statusNode) statusNode.remove();
        } catch (error) {
            console.error('Could not load online Mapillary image details:', error);
            setMapillaryStatus('Could not load Mapillary image details. Check the browser console.', true);
        }
    };

    map.once('load', () => {
        mapReady = true;
        if (liveCameraMode && currentImage) updateMapillaryMarker(currentImage, true);
    });

    const toggle = document.getElementById('live-camera-toggle');
    const expandToggle = document.getElementById('mapillary-expand-toggle');
    const panoramaPointsToggle = document.getElementById('panorama-points-toggle');
    const previousPanoramaButton = document.getElementById('panorama-previous');
    const nextPanoramaButton = document.getElementById('panorama-next');
    const panoramaPlayButton = document.getElementById('panorama-play');
    const AUTO_ADVANCE_INTERVAL_MS = 2500;
    let autoAdvanceTimer = null;
    let autoAdvanceActive = false;
    let sequenceMovePending = false;

    const updateNavigationControls = image => {
        const enabled = Boolean(image?.id);
        previousPanoramaButton.disabled = !enabled;
        nextPanoramaButton.disabled = !enabled;
        panoramaPlayButton.disabled = !enabled;
        const unavailableTitle = 'Load a local panorama to enable navigation.';
        previousPanoramaButton.title = enabled ? 'Previous panorama in the local collection' : unavailableTitle;
        nextPanoramaButton.title = enabled ? 'Next panorama in the local collection' : unavailableTitle;
        panoramaPlayButton.title = enabled
            ? 'Automatically advance to nearby local panoramas every 2.5 seconds'
            : unavailableTitle;
    };

    const stopAutoAdvance = () => {
        autoAdvanceActive = false;
        if (autoAdvanceTimer !== null) {
            window.clearTimeout(autoAdvanceTimer);
            autoAdvanceTimer = null;
        }
        panoramaPlayButton.setAttribute('aria-pressed', 'false');
        panoramaPlayButton.setAttribute('aria-label', 'Start automatic panorama advance');
        panoramaPlayButton.textContent = '▶';
    };

    document.addEventListener('offline-panorama-selecting', () => {
        stopAutoAdvance();
        navigationHistory = [];
        navigationHistoryIndex = -1;
    });

    const setPanoramaPointsVisible = async visible => {
        if (!mapillaryOffline) return;
        panoramaPointsToggle.setAttribute('aria-pressed', String(visible));
        panoramaPointsToggle.textContent = visible ? 'Hide panorama points' : 'Show panorama points';
        if (!visible) {
            if (map.getLayer('offline-panorama-points')) {
                map.setLayoutProperty('offline-panorama-points', 'visibility', 'none');
            }
            return;
        }
        if (!mapReady) {
            panoramaPointsToggle.setAttribute('aria-pressed', 'false');
            panoramaPointsToggle.textContent = 'Show panorama points';
            showPanoramaToast('Map is still loading. Try again in a moment.');
            return;
        }

        try {
            if (!panoramaPointsLoaded) {
                showPanoramaToast('Loading panorama locations...', 0);
                const response = await fetch('/api/offline/points');
                if (!response.ok) {
                    throw new Error(`Panorama locations request failed (${response.status}): ${await response.text()}`);
                }
                const points = await response.json();
                map.addSource('offline-panorama-points', {
                    type: 'geojson',
                    data: points
                });
                map.addLayer({
                    id: 'offline-panorama-points',
                    type: 'circle',
                    source: 'offline-panorama-points',
                    paint: {
                        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 14, 6, 18, 9],
                        'circle-color': '#ff7900',
                        'circle-stroke-width': 1.5,
                        'circle-stroke-color': '#fff'
                    },
                    layout: {
                        visibility: 'none'
                    }
                });
                panoramaPointsLoaded = true;
                if (points.features.length === 0) {
                    showPanoramaToast('No local panorama points were found.');
                } else {
                    const bounds = points.features.reduce((result, feature) => {
                        const [longitude, latitude] = feature.geometry.coordinates;
                        result[0][0] = Math.min(result[0][0], longitude);
                        result[0][1] = Math.min(result[0][1], latitude);
                        result[1][0] = Math.max(result[1][0], longitude);
                        result[1][1] = Math.max(result[1][1], latitude);
                        return result;
                    }, [[Infinity, Infinity], [-Infinity, -Infinity]]);
                    map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 500 });
                    showPanoramaToast(`Loaded ${points.features.length.toLocaleString()} panorama points.`);
                }
            }
            map.setLayoutProperty('offline-panorama-points', 'visibility', 'visible');
        } catch (error) {
            console.error('Could not show local panorama points:', error);
            panoramaPointsToggle.setAttribute('aria-pressed', 'false');
            panoramaPointsToggle.textContent = 'Show panorama points';
            showPanoramaToast('Could not load panorama points. Check the local server and console.');
        }
    };

    const setLiveCameraMode = async enabled => {
        liveCameraMode = enabled;
        document.body.classList.toggle('live-camera-mode', enabled);
        toggle.setAttribute('aria-pressed', String(enabled));

        if (!enabled) {
            stopAutoAdvance();
            document.body.classList.remove('live-camera-expanded');
            expandToggle.setAttribute('aria-pressed', 'false');
            expandToggle.textContent = 'Expand camera';
            await setPanoramaPointsVisible(false);
            if (directionMarkerAdded && directionMarker) {
                directionMarker.remove();
                directionMarkerAdded = false;
            }
            map.easeTo({ pitch: 60, bearing: -20, duration: 350 });
            return;
        }

        try {
            if (!mapillaryOffline) {
                if (!mapillaryAccessToken) {
                    setMapillaryStatus(
                        'Set MAPILLARY_ACCESS_TOKEN in the project .env file to use online Mapillary imagery.',
                        true
                    );
                    return;
                }
                if (typeof window.mapillary?.Viewer !== 'function') {
                    throw new TypeError('The Mapillary viewer library is unavailable.');
                }
                if (!window.mapillaryViewer) {
                    window.mapillaryViewer = new window.mapillary.Viewer({
                        container: 'mapillary-online-viewer',
                        accessToken: mapillaryAccessToken,
                        component: { cover: false }
                    });
                    window.mapillaryViewer.on('error', () => {
                        setMapillaryStatus('Online street view failed to load. Check the Mapillary access token.', true);
                    });
                    window.mapillaryViewer.on('image', handleOnlineImageChange);
                    window.mapillaryViewer.on('pov', () => updatePointerDirection());
                    window.mapillaryViewer.on('bearing', () => updatePointerDirection());
                    panoramaResizeObserver = new ResizeObserver(resizePanoramaViewer);
                    panoramaResizeObserver.observe(document.getElementById('mapillary'));
                }
                const center = map.getCenter();
                await loadNearestImage(center.lng, center.lat);
                return;
            }
            if (!window.offlinePanoramaViewer) {
                window.offlinePanoramaViewer = new OfflinePanoramaViewer(
                    document.getElementById('offline-panorama-canvas')
                );
                window.offlinePanoramaViewer.onBearingChange(updatePointerDirection);
                panoramaResizeObserver = new ResizeObserver(resizePanoramaViewer);
                panoramaResizeObserver.observe(document.getElementById('mapillary'));
            }
            setMapillaryStatus('Searching local offline panoramas...');
            const center = map.getCenter();
            await loadNearestImage(center.lng, center.lat);
        } catch (error) {
            console.error('Offline panorama viewer initialization failed:', error);
            setMapillaryStatus('Offline camera could not start. Check WebGL support and the browser console.', true);
            setLiveCameraMode(false);
        }
    };

    toggle.addEventListener('click', () => {
        setLiveCameraMode(!liveCameraMode);
    });

    panoramaPointsToggle.addEventListener('click', () => {
        const visible = panoramaPointsToggle.getAttribute('aria-pressed') !== 'true';
        setPanoramaPointsVisible(visible);
    });

    const moveBetweenImages = async (direction, automatic = false) => {
        if (!currentImage || !window.offlinePanoramaViewer || sequenceMovePending) return false;
        sequenceMovePending = true;
        const historyStep = direction === 'next' ? 1 : -1;
        const historyImage = navigationHistory[navigationHistoryIndex + historyStep];
        if (historyImage) {
            try {
                await window.offlinePanoramaViewer.loadImage(historyImage);
                window.offlinePanoramaViewer.setBaseBearing(historyImage.compass_angle);
                setPanoramaAttribution(historyImage);
                navigationHistoryIndex += historyStep;
                document.dispatchEvent(new CustomEvent('offline-panorama-loaded', { detail: historyImage }));
                return true;
            } catch (error) {
                console.error('Could not load a panorama from local navigation history:', error);
                if (!automatic) showPanoramaToast('Could not load the previous local panorama.');
                return null;
            } finally {
                sequenceMovePending = false;
            }
        }
        const params = new URLSearchParams({
            id: currentImage.id,
            direction,
            bearing: String(window.offlinePanoramaViewer.getBearing()),
            visited: navigationHistory.slice(0, navigationHistoryIndex + 1)
                .map(image => image.id)
                .join(',')
        });
        try {
            const response = await fetch(`/api/offline/sequence?${params}`);
            if (response.status === 404) {
                if (!automatic) showPanoramaToast('No nearby local panorama found in that direction.');
                return false;
            }
            if (!response.ok) {
                throw new Error(`Local panorama navigation failed (${response.status}): ${await response.text()}`);
            }
            const image = await response.json();
            await window.offlinePanoramaViewer.loadImage(image);
            window.offlinePanoramaViewer.setBaseBearing(image.compass_angle);
            setPanoramaAttribution(image);
            document.dispatchEvent(new CustomEvent('offline-panorama-loaded', { detail: image }));
            const statusNode = document.querySelector('#mapillary .mapillary-status');
            if (statusNode) statusNode.remove();
            return true;
        } catch (error) {
            console.error('Could not move to another local panorama:', error);
            if (!automatic) showPanoramaToast('Could not load the next local panorama.');
            return null;
        } finally {
            sequenceMovePending = false;
        }
    };

    const startAutoAdvance = () => {
        if (!currentImage?.id) {
            showPanoramaToast('Load a local panorama before starting automatic advance.');
            return;
        }
        autoAdvanceActive = true;
        panoramaPlayButton.setAttribute('aria-pressed', 'true');
        panoramaPlayButton.setAttribute('aria-label', 'Stop automatic panorama advance');
        panoramaPlayButton.textContent = 'Ⅱ';

        const advance = async () => {
            if (!autoAdvanceActive) return;
            const advanced = await moveBetweenImages('next', true);
            if (advanced === null) {
                stopAutoAdvance();
                showPanoramaToast('Automatic advance stopped because the next panorama could not be loaded.');
                return;
            }
            if (!advanced) {
                stopAutoAdvance();
                showPanoramaToast('No further nearby local panorama found. Automatic advance stopped.');
                return;
            }
            if (autoAdvanceActive) {
                autoAdvanceTimer = window.setTimeout(advance, AUTO_ADVANCE_INTERVAL_MS);
            }
        };

        autoAdvanceTimer = window.setTimeout(advance, AUTO_ADVANCE_INTERVAL_MS);
    };

    previousPanoramaButton.addEventListener('click', () => {
        stopAutoAdvance();
        moveBetweenImages('previous');
    });
    nextPanoramaButton.addEventListener('click', () => {
        stopAutoAdvance();
        moveBetweenImages('next');
    });
    panoramaPlayButton.addEventListener('click', () => {
        if (autoAdvanceActive) {
            stopAutoAdvance();
        } else {
            startAutoAdvance();
        }
    });

    expandToggle.addEventListener('click', () => {
        const expanded = expandToggle.getAttribute('aria-pressed') !== 'true';
        document.body.classList.toggle('live-camera-expanded', expanded);
        expandToggle.setAttribute('aria-pressed', String(expanded));
        expandToggle.textContent = expanded ? 'Restore camera' : 'Expand camera';
        window.requestAnimationFrame(resizePanoramaViewer);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.body.classList.contains('live-camera-expanded')) {
            document.body.classList.remove('live-camera-expanded');
            expandToggle.setAttribute('aria-pressed', 'false');
            expandToggle.textContent = 'Expand camera';
        }
    });

    map.on('styleimagemissing', (e) => {
        if (!map.hasImage(e.id)) {
            const width = 1;
            const height = 1;
            const data = new Uint8Array(width * height * 4);
            map.addImage(e.id, { width, height, data });
        }
    });

    try {
        const response = await fetch('/points/points.json');
        if (!response.ok) throw new Error('Failed to load points data file');

        const rawData = await response.json();
        const geojsonFeatures = rawData.points.map(item => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [item.lon, item.lat]
            },
            properties: item
        }));

        const geojsonData = {
            type: 'FeatureCollection',
            features: geojsonFeatures
        };

        const addPointsLayer = () => {
            if (map.getSource('points-source')) return;

            map.addSource('points-source', {
                type: 'geojson',
                data: geojsonData
            });

            map.addLayer({
                id: 'points-layer',
                type: 'circle',
                source: 'points-source',
                paint: {
                    'circle-radius': 10,
                    'circle-color': '#007cbf',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
                }
            });

            map.on('click', 'points-layer', (e) => {
                const feature = e.features && e.features[0];
                if (!feature) return;

                const coordinates = feature.geometry.coordinates.slice();
                const properties = feature.properties;
                const content = '<div style="font-family: Arial, sans-serif; text-align: left;">' +
                    Object.entries(properties)
                        .filter(([key]) => key !== 'paint')
                        .map(([key, value]) => `<p style="margin: 4px 0;"><strong>${key}:</strong> ${value}</p>`)
                        .join('') +
                    '</div>';

                new maplibregl.Popup()
                    .setLngLat(coordinates)
                    .setHTML(content)
                    .addTo(map);
            });

            map.on('mouseenter', 'points-layer', () => {
                map.getCanvas().style.cursor = 'pointer';
            });

            map.on('mouseleave', 'points-layer', () => {
                map.getCanvas().style.cursor = '';
            });
        };

        if (map.isStyleLoaded()) {
            addPointsLayer();
        } else {
            map.once('load', addPointsLayer);
        }

        map.on('click', (event) => {
            if (!liveCameraMode || (mapillaryOffline && !window.offlinePanoramaViewer) ||
                (!mapillaryOffline && !window.mapillaryViewer)) return;
            if (map.getLayer('offline-panorama-points')) {
                const panoramaFeature = map.queryRenderedFeatures(event.point, {
                    layers: ['offline-panorama-points']
                })[0];
                if (panoramaFeature) {
                    const [longitude, latitude] = panoramaFeature.geometry.coordinates;
                    loadNearestImage(longitude, latitude);
                    return;
                }
            }
            if (
                map.getLayer('points-layer') &&
                map.queryRenderedFeatures(event.point, { layers: ['points-layer'] }).length
            ) {
                return;
            }

            loadNearestImage(event.lngLat.lng, event.lngLat.lat);
        });

    } catch (error) {
        console.error('Error loading points onto the map:', error);
    }
}

initMap();