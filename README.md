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
