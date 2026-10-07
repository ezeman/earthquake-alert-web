# Earthquake Alert Web

A single-page web application that shows the most recent earthquake near you on an interactive map, using Leaflet and the USGS API.

## Features
- Finds the latest earthquake within 1,000 km of your location over the past 7 days (USGS GeoJSON)
- Falls back to Chiang Mai if location access is denied or unavailable
- Auto-refreshes every 5 minutes
- Shows distance to the quake, color-coded magnitude, and 100/300/500 km radius rings
- Simple and responsive UI (no framework)

## Live Demo
(https://ezeman.github.io/earthquake-alert-web/earthquake_alert_single_file.html)
