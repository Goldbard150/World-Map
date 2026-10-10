async function initMap() {
    maplibregl.setRTLTextPlugin(
        'http://localhost:8000/web/js/mapbox-gl-rtl-text.js',
        null,
        true 
    );

    const map = new maplibregl.Map({
        container: 'map',
        style: 'http://localhost:8080/styles/osm-bright/style.json',
        center: [34.7818, 32.0853],
        zoom: 10
    });

    map.on("load", () => {
        map.setPitch(60);
        map.setBearing(-20);
    });

    // Automatically handle any missing icon requested by the style (like motorcycle_parking_11, parking_11, etc.)
    map.on('styleimagemissing', (e) => {
        // Check if the image has already been added to avoid duplicate additions
        if (!map.hasImage(e.id)) {
            // Create a transparent 1x1 placeholder image dynamically
            const width = 1;
            const height = 1;
            const data = new Uint8Array(width * height * 4);
            map.addImage(e.id, { width, height, data });
        }
    });

    try {
        const response = await fetch('http://localhost:8000/points/points.json');
        if (!response.ok) throw new Error('Failed to load points data file');
        
        const rawData = await response.json();

        // Mapping from data.points and converting lat/lon order to [lon, lat] for MapLibre
        const geojsonFeatures = rawData.points.map(item => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [item.lon, item.lat] // MapLibre requires [lon, lat]
            },
            properties: item
        }));

        const geojsonData = {
            type: 'FeatureCollection',
            features: geojsonFeatures
        };

        map.on('load', () => {
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

            // Popup display on click with all point details
            map.on('click', 'points-layer', (e) => {
                const coordinates = e.features[0].geometry.coordinates.slice();
                const properties = e.features[0].properties;

                let content = '<div style="font-family: Arial, sans-serif; text-align: left;">';
                for (const [key, value] of Object.entries(properties)) {
                    // Exclude the 'paint' object from showing up as raw text in the popup
                    if (key !== 'paint') {
                        content += `<p style="margin: 4px 0;"><strong>${key}:</strong> ${value}</p>`;
                    }
                }
                content += '</div>';

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
        });

    } catch (error) {
        console.error("Error loading points onto the map:", error);
    }
}

initMap();