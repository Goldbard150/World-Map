const INITIAL_LOCATION = [34.7818, 32.0853];
let mapillaryAccessToken = '';

function isMapillaryConfigured() {
    return (
        typeof window.mapillary !== 'undefined' &&
        mapillaryAccessToken.length > 0
    );
}

async function loadMapillaryAccessToken() {
    const response = await fetch('/api/config');
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Could not load local configuration (${response.status}): ${details}`);
    }

    const config = await response.json();
    if (typeof config.mapillaryAccessToken !== 'string' || !config.mapillaryAccessToken.trim()) {
        throw new Error('The local configuration does not include a Mapillary access token.');
    }

    return config.mapillaryAccessToken.trim();
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

async function findNearestImage(lng, lat) {
    const radiusMeters = 100;
    const latitudeDelta = radiusMeters / 111320;
    const longitudeDelta = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));
    const params = new URLSearchParams({
        access_token: mapillaryAccessToken,
        fields: 'id,geometry,compass_angle',
        bbox: [
            lng - longitudeDelta,
            lat - latitudeDelta,
            lng + longitudeDelta,
            lat + latitudeDelta
        ].join(','),
        limit: '100'
    });

    try {
        const response = await fetch(`https://graph.mapillary.com/images?${params}`);
        if (!response.ok) {
            const details = await response.text();
            throw new Error(`Mapillary request failed (${response.status}): ${details}`);
        }

        const data = await response.json();
        const nearestImage = (data?.data ?? [])
            .filter(image => image.geometry?.coordinates?.length === 2)
            .sort((first, second) => {
                const distance = image => {
                    const [imageLng, imageLat] = image.geometry.coordinates;
                    const dx = (imageLng - lng) * 111320 * Math.cos(lat * Math.PI / 180);
                    const dy = (imageLat - lat) * 111320;
                    return Math.hypot(dx, dy);
                };
                return distance(first) - distance(second);
            })
            .find(image => {
                const [imageLng, imageLat] = image.geometry.coordinates;
                const dx = (imageLng - lng) * 111320 * Math.cos(lat * Math.PI / 180);
                const dy = (imageLat - lat) * 111320;
                return Math.hypot(dx, dy) <= radiusMeters;
            });

        return nearestImage ?? null;
    } catch (error) {
        throw new Error('Could not search nearby Mapillary images.', { cause: error });
    }
}

async function loadNearestImage(lng, lat) {
    if (!isMapillaryConfigured() || !window.mapillaryViewer) return;

    setMapillaryStatus('Searching for nearby Mapillary images...');

    try {
        const nearestImage = await findNearestImage(lng, lat);
        if (!nearestImage) {
            setMapillaryStatus('No Mapillary images found within 100 meters of this location.', true);
            return;
        }

        await window.mapillaryViewer.moveTo(nearestImage.id);
        const statusNode = document.querySelector('#mapillary .mapillary-status');
        if (statusNode) statusNode.remove();
        return nearestImage;
    } catch (error) {
        console.error('Error loading nearest Mapillary image:', error);
        setMapillaryStatus('Could not load nearby Mapillary images. Check the browser console for details.', true);
    }
}

async function initMap() {
    try {
        mapillaryAccessToken = await loadMapillaryAccessToken();
    } catch (error) {
        console.error('Mapillary configuration error:', error);
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
    let currentImageId;
    let directionMarker;
    let directionMarkerAdded = false;
    let markerUpdateId = 0;
    let directionUpdatePending = false;
    let liveCameraMode = false;
    let directionSyncTimer;
    let mapillaryResizeObserver;

    const resizeMapillaryViewer = () => {
        if (typeof window.mapillaryViewer?.resize !== 'function') return;

        try {
            window.mapillaryViewer.resize();
        } catch (error) {
            console.error('Could not resize the Mapillary viewer:', error);
        }
    };

    const updatePointerDirection = async () => {
        if (!window.mapillaryViewer || !directionMarker || directionUpdatePending) return;

        directionUpdatePending = true;
        try {
            const pointOfView = await window.mapillaryViewer.getPointOfView();
            if (Number.isFinite(pointOfView?.bearing)) {
                directionMarker.setRotation(pointOfView.bearing);
            }
        } catch (error) {
            console.error('Could not sync the pointer direction with the Mapillary camera:', error);
        } finally {
            directionUpdatePending = false;
        }
    };

    const updateMapillaryMarker = async (imageId, centerMap = false) => {
        if (!window.mapillaryViewer || !mapReady || !imageId) return;

        const currentUpdateId = ++markerUpdateId;
        try {
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
            if (currentUpdateId !== markerUpdateId) return;
            if (
                !Array.isArray(coordinates) ||
                coordinates.length !== 2 ||
                !coordinates.every(Number.isFinite)
            ) {
                throw new Error(`Mapillary image ${imageId} did not include a valid point geometry.`);
            }

            if (currentImageId !== imageId) {
                return;
            }

            if (!directionMarker) {
                const markerElement = document.createElement('button');
                markerElement.type = 'button';
                markerElement.className = 'mapillary-direction-marker';
                markerElement.title = 'Current Mapillary image and direction';
                markerElement.setAttribute('aria-label', 'Current Mapillary image and direction');
                markerElement.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true">' +
                    '<path d="M24 2 43 43 24 34 5 43 24 2Z" fill="#ff7900" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
                    '<circle cx="24" cy="28" r="5" fill="#fff"/>' +
                    '</svg>';
                markerElement.addEventListener('click', event => {
                    event.stopPropagation();
                    if (currentImageId) {
                        window.mapillaryViewer.moveTo(currentImageId).catch(error => {
                            console.error('Could not reopen the current Mapillary image:', error);
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

            if (centerMap) {
                map.easeTo({ center: coordinates, duration: 350 });
            }
            updatePointerDirection();
        } catch (error) {
            console.error('Could not sync the Mapillary image position with the map:', error);
        }
    };

    map.once('load', () => {
        mapReady = true;
        if (liveCameraMode && currentImageId) {
            updateMapillaryMarker(currentImageId, true);
        }
    });

    const toggle = document.getElementById('live-camera-toggle');
    const expandToggle = document.getElementById('mapillary-expand-toggle');
    const setLiveCameraMode = enabled => {
        liveCameraMode = enabled;
        document.body.classList.toggle('live-camera-mode', enabled);
        toggle.setAttribute('aria-pressed', String(enabled));

        if (!enabled) {
            document.body.classList.remove('live-camera-expanded');
            expandToggle.setAttribute('aria-pressed', 'false');
            expandToggle.textContent = 'Expand camera';
            if (directionSyncTimer) {
                window.clearInterval(directionSyncTimer);
                directionSyncTimer = undefined;
            }
            if (directionMarkerAdded && directionMarker) {
                directionMarker.remove();
                directionMarkerAdded = false;
            }
            map.easeTo({ pitch: 60, bearing: -20, duration: 350 });
            return;
        }

        if (!isMapillaryConfigured()) {
            setMapillaryStatus('Set MAPILLARY_ACCESS_TOKEN in the project .env file, then restart the server.', true);
            return;
        }

        try {
            if (!window.mapillaryViewer) {
                if (typeof window.mapillary?.Viewer !== 'function') {
                    throw new TypeError('mapillary.Viewer is not available on the global object');
                }

                setMapillaryStatus('Loading nearby Mapillary imagery...');
                window.mapillaryViewer = new window.mapillary.Viewer({
                    container: 'mapillary',
                    accessToken: mapillaryAccessToken,
                    component: {
                        cover: false
                    }
                });
                mapillaryResizeObserver = new ResizeObserver(resizeMapillaryViewer);
                mapillaryResizeObserver.observe(document.getElementById('mapillary'));

                window.mapillaryViewer.on('error', () => {
                    setMapillaryStatus('Street view failed to load. Check the Mapillary access token.', true);
                });

                window.mapillaryViewer.on('image', event => {
                    currentImageId = event.image.id;
                    updateMapillaryMarker(currentImageId, true);
                });
                window.mapillaryViewer.on('pov', updatePointerDirection);
                window.mapillaryViewer.on('bearing', updatePointerDirection);
                directionSyncTimer = window.setInterval(updatePointerDirection, 100);
                window.mapillaryViewer.on('remove', () => {
                    window.clearInterval(directionSyncTimer);
                });
                const center = map.getCenter();
                loadNearestImage(center.lng, center.lat).then(image => {
                    if (image) {
                        currentImageId = image.id;
                        updateMapillaryMarker(currentImageId, true);
                    }
                });
            } else {
                const center = map.getCenter();
                loadNearestImage(center.lng, center.lat).then(image => {
                    if (image) {
                        currentImageId = image.id;
                        updateMapillaryMarker(currentImageId, true);
                    }
                });
                directionSyncTimer = window.setInterval(updatePointerDirection, 100);
            }
        } catch (error) {
            console.error('Mapillary viewer initialization failed:', error);
            setMapillaryStatus('Street view could not start. Check the Mapillary access token.', true);
            setLiveCameraMode(false);
        }
    };

    toggle.addEventListener('click', () => {
        setLiveCameraMode(!liveCameraMode);
    });

    expandToggle.addEventListener('click', () => {
        const expanded = expandToggle.getAttribute('aria-pressed') !== 'true';
        document.body.classList.toggle('live-camera-expanded', expanded);
        expandToggle.setAttribute('aria-pressed', String(expanded));
        expandToggle.textContent = expanded ? 'Restore camera' : 'Expand camera';
        window.requestAnimationFrame(resizeMapillaryViewer);
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
            if (!liveCameraMode || !window.mapillaryViewer) return;
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