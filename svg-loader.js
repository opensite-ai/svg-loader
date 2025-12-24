"use strict";

const { get, set, del, entries } = require("idb-keyval");
const cssScope = require("./lib/scope-css");
const cssUrlFixer = require("./lib/css-url-fixer");
const counter = require("./lib/counter");

const CACHE_PREFIX = "loader_";
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000 * 24 * 30;
const SVG_SELECTOR = "svg[data-src]";
const UNRENDERED_SELECTOR = "svg[data-src]:not([data-id])";

const memoryCache = new Map();
const inflightRequests = new Map();
const attributesSet = new WeakMap();
const observedElements = new WeakSet();
const eventNameCache = new Set();

const safeParseJson = (value) => {
    if (!value) {
        return null;
    }

    if (typeof value === "object") {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (e) {
        return null;
    }
};

const getCacheKey = (url) => `${CACHE_PREFIX}${url}`;

const removeCacheEntry = async (cacheKey) => {
    try {
        await del(cacheKey);
    } catch (e) {}

    try {
        localStorage.removeItem(cacheKey);
    } catch (e) {}
};

const getCacheEntry = async (url) => {
    const cacheKey = getCacheKey(url);
    let item;

    try {
        item = await get(cacheKey);
    } catch (e) {}

    if (!item) {
        try {
            item = localStorage.getItem(cacheKey);
        } catch (e) {}
    }

    if (!item) {
        return null;
    }

    const parsed = safeParseJson(item);

    if (!parsed || typeof parsed !== "object") {
        await removeCacheEntry(cacheKey);
        return null;
    }

    if (Date.now() < parsed.expiry) {
        return parsed.data;
    }

    await removeCacheEntry(cacheKey);
    return null;
};

const setCacheEntry = async (url, data, ttlMs) => {
    const cacheKey = getCacheKey(url);
    const payload = JSON.stringify({
        data,
        expiry: Date.now() + ttlMs
    });

    try {
        await set(cacheKey, payload);
        return;
    } catch (e) {}

    try {
        localStorage.setItem(cacheKey, payload);
    } catch (e) {
        console.warn("Failed to set cache: ", e);
    }
};

const parseCacheTtl = (cacheOpt) => {
    if (!cacheOpt || cacheOpt === "disabled") {
        return DEFAULT_CACHE_TTL_MS;
    }

    const cacheSeconds = Number.parseInt(cacheOpt, 10);

    if (!Number.isFinite(cacheSeconds) || cacheSeconds <= 0) {
        return DEFAULT_CACHE_TTL_MS;
    }

    return cacheSeconds * 1000;
};

const getAllEventNames = () => {
    if (eventNameCache.size) {
        return eventNameCache;
    }

    if (typeof document !== "undefined" && document.body) {
        for (const prop in document.body) {
            if (prop.startsWith("on")) {
                eventNameCache.add(prop);
            }
        }
    }

    // SVG <animate> events
    eventNameCache.add("onbegin");
    eventNameCache.add("onend");
    eventNameCache.add("onrepeat");

    // Some non-standard events, just in case the browser is handling them
    eventNameCache.add("onfocusin");
    eventNameCache.add("onfocusout");
    eventNameCache.add("onbounce");
    eventNameCache.add("onfinish");
    eventNameCache.add("onshow");

    return eventNameCache;
};

const renderBody = (elem, options, body) => {
    const { enableJs, disableUniqueIds, disableCssScoping, spriteIconId } = options;
    const isSpriteIcon = !!spriteIconId;
    const parser = new DOMParser();
    const doc = parser.parseFromString(body, "text/html");
    const fragment = isSpriteIcon ? doc.getElementById(spriteIconId) : doc.querySelector("svg");

    if (!fragment) {
        throw Error("Resource returned invalid SVG markup.");
    }

    const eventNames = getAllEventNames();
    const elemAttributesSet = attributesSet.get(elem) || new Set();
    const elemUniqueId = elem.getAttribute("data-id") || `svg-loader_${counter.incr()}`;
    const idMap = {};

    if (!disableUniqueIds) {
        // Append a unique suffix for every ID so elements don't conflict.
        const idElements = fragment.querySelectorAll("[id]");
        for (const element of idElements) {
            const id = element.getAttribute("id");
            const newId = `${id}_${counter.incr()}`;
            element.setAttribute("id", newId);
            idMap[id] = newId;
        }
    }

    const processElement = (el) => {
        const tagName = el.tagName ? el.tagName.toLowerCase() : "";

        // Unless explicitly set, remove JS code (default)
        if (tagName === "script") {
            el.remove();
            if (!enableJs) {
                return;
            }

            const scriptEl = document.createElement("script");
            if (el.childNodes[0]) {
                scriptEl.appendChild(el.childNodes[0]);
            }
            elem.appendChild(scriptEl);
            return;
        }

        const attributesToRemove = [];

        for (let i = 0; i < el.attributes.length; i++) {
            const { name, value } = el.attributes[i];
            const newValue = cssUrlFixer(idMap, value, name);

            if (value !== newValue) {
                el.setAttribute(name, newValue);
            }

            const lowerName = name.toLowerCase();

            // Remove event functions: onmouseover, onclick ... unless specifically enabled
            if (eventNames.has(lowerName) && !enableJs) {
                attributesToRemove.push(name);
                continue;
            }

            // Remove "javascript:..." unless specifically enabled
            if (["href", "xlink:href", "values"].includes(lowerName) && value.startsWith("javascript") && !enableJs) {
                attributesToRemove.push(name);
            }
        }

        for (const attr of attributesToRemove) {
            el.removeAttribute(attr);
        }

        // .first -> [data-id="svg_loader_341xx"] .first
        // Makes sure that class names don't conflict with each other.
        if (tagName === "style" && !disableCssScoping && el.innerHTML) {
            let newValue = cssScope(el.innerHTML, `[data-id="${elemUniqueId}"]`, idMap);
            newValue = cssUrlFixer(idMap, newValue);
            if (newValue !== el.innerHTML) {
                el.innerHTML = newValue;
            }
        }
    };

    processElement(fragment);

    const childElements = fragment.querySelectorAll("*");
    for (const element of childElements) {
        processElement(element);
    }

    // For a sprite we want to include the whole DOM of sprite element
    elem.innerHTML = isSpriteIcon ? fragment.outerHTML : fragment.innerHTML;

    // This code block basically merges attributes of the original SVG
    // the SVG element where it is called from. For eg,
    //
    // Let's say the original SVG is this:
    //
    // a.svg = <svg viewBox='..' ...></svg>
    //
    // and it is used as with svg-loader as <svg data-src="./a.svg" width="32"></svg>
    // this will create a combined element  <svg data-src="./a.svg" width="32" viewBox='..' ...></svg>
    //
    // For sprite icons, we don't need this as we are including the whole outerHTML.
    if (!isSpriteIcon) {
        for (let i = 0; i < fragment.attributes.length; i++) {
            const { name, value } = fragment.attributes[i];

            // Don't override the attributes already defined, but override the ones that
            // were in the original element
            if (!elem.getAttribute(name) || elemAttributesSet.has(name)) {
                elemAttributesSet.add(name);
                elem.setAttribute(name, value);
            }
        }
    }

    attributesSet.set(elem, elemAttributesSet);
    elem.setAttribute("data-id", elemUniqueId);

    const event = new CustomEvent("iconload", {
        bubbles: true
    });
    elem.dispatchEvent(event);

    if (elem.getAttribute("oniconload")) {
        // Handling (and executing) event attribute for our event (oniconload)
        // isn't straightforward. Because a) the code is a raw string b) there's
        // no way to specify the context for execution. So, `this` in the attribute
        // will point to `window` instead of the element itself.
        //
        // Here we are recycling a rarely used GlobalEventHandler 'onauxclick'
        // and offloading the execution to the browser. This is a hack, but because
        // the event doesn't bubble, it shouldn't affect anything else in the code.
        elem.setAttribute("onauxclick", elem.getAttribute("oniconload"));

        const auxEvent = new CustomEvent("auxclick", {
            bubbles: false,
            view: window
        });
        elem.dispatchEvent(auxEvent);

        elem.removeAttribute("onauxclick");
    }
};

const dispatchError = (elem, error) => {
    console.error(error);
    const event = new CustomEvent("iconloaderror", {
        bubbles: true,
        detail: error.toString()
    });
    elem.dispatchEvent(event);

    if (elem.getAttribute("oniconloaderror")) {
        // the oniconloaderror inline function will have access to an `error` argument
        const loadErrorFunction = Function("error", elem.getAttribute("oniconloaderror"));
        loadErrorFunction(error);
    }
};

const renderIcon = async (elem) => {
    if (!elem || !elem.getAttribute) {
        return;
    }

    const dataSrc = elem.getAttribute("data-src");
    if (!dataSrc) {
        return;
    }

    let url;
    try {
        url = new URL(dataSrc, globalThis.location);
    } catch (e) {
        dispatchError(elem, e);
        return;
    }

    const src = url.toString().replace(url.hash, "");
    const spriteIconId = url.hash ? url.hash.replace("#", "") : "";

    const cacheOpt = elem.getAttribute("data-cache");
    const isCachingEnabled = cacheOpt !== "disabled";
    const cacheTtlMs = parseCacheTtl(cacheOpt);

    const enableJs = elem.getAttribute("data-js") === "enabled";
    const disableUniqueIds = elem.getAttribute("data-unique-ids") === "disabled";
    const disableCssScoping = elem.getAttribute("data-css-scoping") === "disabled";

    const renderBodyCb = (body) =>
        renderBody(elem, { enableJs, disableUniqueIds, disableCssScoping, spriteIconId }, body);

    const cachedMemory = memoryCache.get(src);
    if (cachedMemory) {
        renderBodyCb(cachedMemory);
        return;
    }

    if (isCachingEnabled) {
        const cachedStorage = await getCacheEntry(src);
        if (cachedStorage) {
            memoryCache.set(src, cachedStorage);
            renderBodyCb(cachedStorage);
            return;
        }
    }

    if (inflightRequests.has(src)) {
        try {
            const body = await inflightRequests.get(src);
            if (body) {
                renderBodyCb(body);
            }
        } catch (e) {
            dispatchError(elem, e);
        }
        return;
    }

    // De-duplicate in-flight fetches for the same source.
    const requestPromise = fetch(src)
        .then((response) => {
            if (!response.ok) {
                throw Error(`Request for '${src}' returned ${response.status} (${response.statusText})`);
            }
            return response.text();
        })
        .then((body) => {
            const bodyLower = body.toLowerCase().trim();

            if (!(bodyLower.startsWith("<svg") || bodyLower.startsWith("<?xml") || bodyLower.startsWith("<!doctype"))) {
                throw Error(`Resource '${src}' returned an invalid SVG file`);
            }

            if (isCachingEnabled) {
                setCacheEntry(src, body, cacheTtlMs);
            }

            memoryCache.set(src, body);
            return body;
        });

    inflightRequests.set(src, requestPromise);

    try {
        const body = await requestPromise;
        renderBodyCb(body);
    } catch (e) {
        dispatchError(elem, e);
    } finally {
        inflightRequests.delete(src);
    }
};

let intersectionObserver;
if (globalThis.IntersectionObserver) {
    intersectionObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    renderIcon(entry.target);
                    intersectionObserver.unobserve(entry.target);
                }
            });
        },
        {
            // Keep high root margin because intersection observer
            // can be slow to react
            rootMargin: "1200px"
        }
    );
}

const queueSvgElement = (element) => {
    if (!element || element.getAttribute("data-id")) {
        return;
    }

    if (element.getAttribute("data-loading") === "lazy" && intersectionObserver) {
        if (!observedElements.has(element)) {
            observedElements.add(element);
            intersectionObserver.observe(element);
        }
        return;
    }

    renderIcon(element);
};

const collectSvgElements = (node) => {
    const elements = [];

    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return elements;
    }

    if (node.matches && node.matches(UNRENDERED_SELECTOR)) {
        elements.push(node);
    }

    if (node.querySelectorAll) {
        node.querySelectorAll(UNRENDERED_SELECTOR).forEach((element) => elements.push(element));
    }

    return elements;
};

function renderAllSVGs(root = document) {
    if (!root || !root.querySelectorAll) {
        return;
    }

    root.querySelectorAll(UNRENDERED_SELECTOR).forEach(queueSvgElement);
}

let observerAdded = false;
const addObservers = () => {
    if (observerAdded || !globalThis.MutationObserver) {
        return;
    }

    observerAdded = true;

    const observer = new MutationObserver((mutationRecords) => {
        mutationRecords.forEach((record) => {
            if (record.type === "childList") {
                record.addedNodes.forEach((node) => {
                    collectSvgElements(node).forEach(queueSvgElement);
                });
            }

            if (record.type === "attributes" && record.target) {
                const target = record.target;
                if (target.matches && target.matches(SVG_SELECTOR)) {
                    renderIcon(target);
                }
            }
        });
    });

    observer.observe(document.documentElement, {
        attributeFilter: ["data-src"],
        attributes: true,
        childList: true,
        subtree: true
    });
};

if (globalThis.addEventListener && typeof document !== "undefined") {
    const init = () => {
        renderAllSVGs();
        addObservers();
    };

    if (document.readyState === "loading") {
        globalThis.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
}

globalThis.SVGLoader = globalThis.SVGLoader || {};
globalThis.SVGLoader.destroyCache = async () => {
    // Handle error, "mutation operation was attempted on a database"
    // with try-catch
    try {
        const entriesCache = await entries();

        for (const entry of entriesCache) {
            if (entry[0].startsWith(CACHE_PREFIX)) {
                await del(entry[0]);
            }
        }
    } catch (e) {}

    try {
        Object.keys(localStorage).forEach((key) => {
            if (key.startsWith(CACHE_PREFIX)) {
                localStorage.removeItem(key);
            }
        });
    } catch (e) {}
};
