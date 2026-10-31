#!/usr/bin/env python3
"""Browser regression checks for local stop-icon selection and a synthetic live feed."""
import argparse
import base64
import datetime as dt
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

PIXEL = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X4lGAAAAAElFTkSuQmCC")
CFG_KEY = "msila_tracker_cfg_v1"
CHOICES = ["sign", "shelter", "bus", "pin"]


def run_case(browser, url, width, height, *, live=False, output_dir=None):
    context = browser.new_context(
        viewport={"width": width, "height": height},
        service_workers="block", reduced_motion="reduce",
    )
    config = {"server": "https://test.invalid", "token": "qa-synthetic-token" if live else "", "email": "", "password": "", "stopIcon": "sign"}
    context.add_init_script("if (!localStorage.getItem(" + json.dumps(CFG_KEY) + ")) localStorage.setItem(" + json.dumps(CFG_KEY) + "," + json.dumps(json.dumps(config)) + ");")
    context.route("https://tile.openstreetmap.org/**", lambda route: route.fulfill(status=200, content_type="image/png", body=PIXEL))

    def api(route):
        path = route.request.url.split("/api/")[-1].split("?")[0]
        if path == "devices":
            data = [{"id": 1, "name": "QA BUS /17", "uniqueId": "QA/17", "status": "online"}]
        elif path == "positions":
            data = [{"deviceId": 1, "latitude": 35.7039, "longitude": 4.5306, "speed": 8.0, "course": 90, "fixTime": dt.datetime.now(dt.timezone.utc).isoformat(), "attributes": {}}]
        else:
            data = {"version": "synthetic-test"}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
    context.route("https://test.invalid/**", api)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url, wait_until="networkidle")
    page.wait_for_function("Number(document.querySelector('#expectedStopCount').textContent)>0")
    if live:
        page.wait_for_function("document.body.dataset.source==='live'")
        if width < 1000:
            page.locator("#btnFleetDock").click()
        page.locator("#btnFit").click()
        page.wait_for_selector(".bus-marker", state="attached")
        assert page.locator(".bus-marker [data-stop-icon]").count() == 0
        if width < 1000:
            page.locator("#btnCloseSb").click()
    original_look = page.locator("html").get_attribute("data-map-look")
    page.locator("#btnMapLook").click()
    assert page.locator("html").get_attribute("data-map-look") != original_look
    page.locator("#btnMapLook").click()
    assert page.locator("html").get_attribute("data-map-look") == original_look
    if width < 1000:
        page.locator("#btnStopsDock").click()
    else:
        page.locator("#tabStops").click()
    assert page.locator("#stopIconChoices button").count() == 4
    assert "المجموعة" not in page.locator("#expectedGroupFilter").inner_text()
    assert "الحافلة رقم" in page.locator("#expectedGroupFilter").inner_text()
    for choice in CHOICES:
        page.locator('[data-stop-icon-choice="' + choice + '"]').click()
        assert page.locator('[data-stop-icon-choice="' + choice + '"]').get_attribute("aria-pressed") == "true"
        assert page.evaluate("JSON.parse(localStorage.getItem('" + CFG_KEY + "')).stopIcon") == choice
        page.wait_for_function("document.querySelectorAll('.expected-marker [data-stop-icon]').length>0")
        marker_styles = page.locator(".expected-marker [data-stop-icon]").evaluate_all("nodes => [...new Set(nodes.map(n => n.getAttribute('data-stop-icon')))]")
        assert marker_styles == [choice], marker_styles
        list_styles = page.locator("#expectedStopList .ep-icon").evaluate_all("nodes => [...new Set(nodes.map(n => n.getAttribute('data-stop-icon')))]")
        assert list_styles == [choice], list_styles

    # Open an individual point: its popup must retain clear bus-number/non-official wording.
    page.locator("#expectedStopList button").first.click()
    page.wait_for_selector(".expected-stop-popup .stop-bus-usage", state="visible")
    popup = page.locator(".expected-stop-popup").inner_text()
    assert "الحافلة رقم" in popup or "الحافلات رقم" in popup, popup
    assert "رسمية" in popup
    assert "مجموعة" not in popup
    assert page.locator('.expected-marker .ep-waiting[data-stop-icon="pin"]').count() > 0
    if page.locator("#btnObservedStops").get_attribute("aria-pressed") != "true":
        page.locator("#btnObservedStops").click()
    page.wait_for_function("document.querySelectorAll('.obs-stop-pin').length>0")
    assert page.locator(".obs-stop-pin[data-stop-icon]").count() == 0

    page.reload(wait_until="networkidle")
    page.wait_for_selector("#stopIconChoices button", state="attached")
    assert page.locator('[data-stop-icon-choice="pin"]').get_attribute("aria-pressed") == "true"
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), "horizontal page overflow"
    assert not errors, errors
    if output_dir:
        if width < 1000:
            page.locator("#btnStopsDock").click()
        else:
            page.locator("#tabStops").click()
        page.locator("#stopIconChoices").screenshot(path=str(output_dir / f"stop-icons-{width}-{'live' if live else 'demo'}.png"))
    context.close()
    print(f"PASS {width}x{height} {'synthetic-live' if live else 'demo'}: four icons, map/list updates, persistence, bus-number labels, separate GPS/bus marks", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:9041/")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"])
        for width, height in ((1280, 800), (390, 844), (320, 740)):
            run_case(browser, args.url, width, height, output_dir=args.output)
            run_case(browser, args.url, width, height, live=True, output_dir=args.output)
        browser.close()


if __name__ == "__main__":
    main()
