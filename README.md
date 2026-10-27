# M’sila Bus Tracker — Updated Source (v4)

This directory contains the updated static website source, its route data, and bundled Leaflet assets. It is separate from the older original GitHub version.

## Run locally

Python 3 is sufficient; no package installation is required to serve the website. From this directory, run:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser. Serving over HTTP (rather than opening `index.html` directly) is needed for browser features such as the service worker.

## Performance modes

The display settings offer automatic, balanced, strong-device, light, and ultra-saving modes. Automatic mode selects light mode on lower-capability or data-saving connections, strong-device mode when both available memory and processor-core signals are high, and balanced mode otherwise. Strong-device mode smooths bus-marker movement without increasing live-data polling; reduced-motion preferences are respected.

## Contents

- `index.html`, `src/`, `sw.js`, `manifest.webmanifest`, and the icons: website interface and app shell.
- `msila_routes.json`: route data used by the site.
- `vendor/`: bundled Leaflet library and map marker/layer images.
- `tools/`: the project’s QA and upgrade helper scripts; these are optional and are not needed to run the site.

This is a static-site source package; it does not include deployment credentials, hidden deployment state, or generated caches.

## Observed stop locations

`data/observed_stops.json` contains seven aggregate GPS stop clusters derived from read-only observations on 2026-10-27. The set contains 637 successful 30-second snapshots of 57 bus records and records the two major observation gaps and five failed reads. The map labels these as observed GPS stop locations, not official passenger stations or live arrival predictions. Bus identifiers and credentials are not included.

## Nearby search, estimates, favorites, and replay

- Nearby search uses the browser's location permission and compares straight-line distances to fresh, online buses and the observed GPS clusters. Location is used in the page and is not sent to a separate service.
- An arrival estimate is shown only when a bus has a recent position and a known GPS heading roughly toward the selected point. It divides straight-line distance by the current reported speed; it does not follow roads, account for traffic or dwell time, or represent an official timetable.
- Movement replay uses positions collected while the page is open. In supported performance modes, up to one hour is retained on the same device in local browser storage; it is not uploaded to the tracking server.
- Favorite stops, user-edited labels, and correction notes are stored locally in that browser. The static site has no server for receiving shared name corrections; the user can copy a suggestion to share it manually.
- Favorite-stop alerts require live data and the page to remain open. Browser notifications are optional and require permission. GitHub Pages does not provide a background push service for alerts after the page is closed.
