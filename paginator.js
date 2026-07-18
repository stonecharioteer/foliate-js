const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const ResizeObserverImpl = globalThis.ResizeObserver
    ?? class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect() {}
    }

const createMediaQueryList = query => {
    if (typeof globalThis.matchMedia === 'function') return globalThis.matchMedia(query)
    return {
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
    }
}

const getViewportScale = () => {
    const raw = globalThis.visualViewport?.scale ?? 1
    // Treat near-1 values as exactly 1 — some Android WebViews report
    // scales like 1.0001 due to display density rounding.
    return Math.abs(raw - 1) < 0.01 ? 1 : raw
}

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const easeSpring = t => {
    const c4 = (2 * Math.PI) / 3
    return t === 0 ? 0
        : t === 1 ? 1
        : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
}
const animate = (a, b, duration, ease, render, signal) => new Promise(resolve => {
    let start
    const step = now => {
        if (signal?.cancelled) return resolve({ completed: false })
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve({ completed: true })
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve({ completed: true })
    }
    if (signal?.cancelled) return resolve({ completed: false })
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve({ completed: true })
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const getSafeBackground = doc => {
    try {
        if (!doc?.defaultView || !doc.body || !doc.documentElement) return null
        return getBackground(doc)
    } catch {
        return null
    }
}

const getTargetElement = target =>
    target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement ?? null

const hasRangeSelection = target => {
    const doc = target?.ownerDocument
    const sel = doc?.getSelection?.()
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.type === 'Range'
}

const isEditableTarget = target => {
    const el = getTargetElement(target)
    if (!el?.closest) return false
    return !!el.closest(
        'input, textarea, select, [contenteditable], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
}

const SNAP_MAX_VELOCITY = 2.0 // px/ms; ~1-2 page widths of momentum
const TOUCH_SELECTION_HOLD_MS = 280
const TOUCH_SELECTION_DRIFT_PX = 30
const TOUCH_SELECTION_CORNER_HOLD_MS = 420
const TOUCH_SELECTION_CORNER_COOLDOWN_MS = 520
const TOUCH_SELECTION_CORNER_MIN_PX = 40
const TOUCH_SELECTION_CORNER_MAX_PX = 88
const TOUCH_STATE_IDLE = 'IDLE'
const TOUCH_PENDING = 'TOUCH_PENDING'
const TOUCH_SWIPE = 'TOUCH_SWIPE'
const SELECTION_PRIMED = 'SELECTION_PRIMED'
const SELECTION_ACTIVE = 'SELECTION_ACTIVE'

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserverImpl(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                const background = getBackground(doc)
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout) return
        if (!this.document) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, marginTop = 0, marginBottom = 0, marginLeft = 0, marginRight = 0 } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - marginTop - marginBottom}px`,
                'max-width': vertical
                    ? `${width - marginLeft - marginRight}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        if (!this.document) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserverImpl(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, Element, or logical page
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = createMediaQueryList('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchHoldTimer
    #touchScrolled
    // While a native touch selection is active, pin paginated scroll to the
    // current page. Android Chrome drags selection handles in browser chrome,
    // without delivering touchmove/touchend to the page, but it still
    // auto-scrolls the overflow container near edges. Pinning prevents that
    // browser-owned handle drag from making adjacent columns genuinely visible.
    #selectionScrollPin
    #selectionPinAlignRaf = null
    #lastVisibleRange
    #swipePreview
    #peekView
    #peekLoadToken = 0
    // ── Page-peel (MER-171 v2) ────────────────────────────────────────────
    // When a curl delegate is installed, this paginator is in curl mode: its
    // own slide animation and swipe preview stay out of the way, touch drags
    // are forwarded to the delegate, and the owned peel engine drives turns.
    #curlDelegate = null
    // Warm clone of the current page ({ page, front, back }) built on idle so
    // a peel can start within a frame; ownership passes to the delegate's
    // provider on preparePeel().
    #peelWarm = null
    #peelWarmScheduled = false
    // { dir, homePage } while a peel is prepared (live doc silently
    // translated to the adjacent page) until commitPeel()/cancelPeel().
    #peelState = null
    // Columns per viewport from the last layout (1 or 2); the peel turns one.
    #pageColumns = 1
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
            touch-action: pan-y;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_margin-top: var(--_margin);
            --_margin-bottom: var(--_margin);
            --_margin-left: 0px;
            --_margin-right: 0px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(max(var(--_half-gap), var(--_margin-left)), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(max(var(--_half-gap), var(--_margin-right)), 1fr);
            grid-template-rows:
                minmax(var(--_margin-top), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin-bottom), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            position: relative;
            overflow: hidden;
            touch-action: pan-y;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header {
            display: grid;
            height: var(--_margin-top);
        }
        #footer {
            display: grid;
            height: var(--_margin-bottom);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        // Invariant: one touch sequence, one gesture owner.
        // Do not set data-* attributes in the custom-element constructor:
        // Chrome can throw during createElement if attributes are mutated here.

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            this.#enforceSelectionScrollPin()
            this.dispatchEvent(new Event('scroll'))
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('touchcancel', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
            doc.addEventListener('touchcancel', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', e =>
                // Touch/pen selection should never trigger auto page-turn while selecting.
                // Keep cross-page drag selection behavior for mouse only.
                isPointerSelecting = (e.pointerType || 'mouse') === 'mouse')
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            doc.addEventListener('pointercancel', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                const ownsTouchSelection = this.#syncTouchSelectionOwnership()
                if (this.scrolled) return
                const sel = doc.getSelection()
                const hasRange = sel && !sel.isCollapsed
                    && sel.rangeCount > 0 && sel.type === 'Range'
                if (hasRange
                    && (ownsTouchSelection || (!isPointerSelecting && !isKeyboardSelecting))) {
                    // Android Chrome selection-handle drags are browser UI, not
                    // page touch events. Keep the paginated container pinned so
                    // handle auto-scroll cannot expose the next/previous column.
                    this.#pinSelectionScroll()
                }
                else if (!hasRange) this.#clearSelectionScrollPin()
                const range = this.#lastVisibleRange
                if (!range) return
                if (!sel?.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view?.document) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    #applyStylesToDoc(doc, styles = this.#styles) {
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'margin':
                this.#top.style.setProperty('--_margin', value)
                break
            case 'margin-top':
            case 'margin-bottom':
            case 'margin-left':
            case 'margin-right':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #computeLayout(vertical, rtl, { updateChrome = false, background } = {}) {
        if (updateChrome) {
            this.#vertical = vertical
            this.#rtl = rtl
            this.#top.classList.toggle('vertical', vertical)
            if (background != null) this.#background.style.background = background
        }

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const parsedScalarMargin = parseFloat(style.getPropertyValue('--_margin'))
        const scalarMargin = Number.isNaN(parsedScalarMargin) ? 0 : parsedScalarMargin
        const parseMargin = (name, fallback) => {
            const parsed = parseFloat(style.getPropertyValue(name))
            return Number.isNaN(parsed) ? fallback : parsed
        }
        const marginTop = parseMargin('--_margin-top', scalarMargin)
        const marginBottom = parseMargin('--_margin-bottom', scalarMargin)
        const marginLeft = parseMargin('--_margin-left', 0)
        const marginRight = parseMargin('--_margin-right', 0)
        const margin = vertical ? marginTop : marginLeft
        if (updateChrome) this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            if (updateChrome) {
                this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
                this.#top.style.padding = '0'
                this.heads = null
                this.feet = null
                this.#header.replaceChildren()
                this.#footer.replaceChildren()
            }
            const columnWidth = maxInlineSize
            this.#pageColumns = 1
            return { flow, margin, marginTop, marginBottom, marginLeft, marginRight, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        // Visible columns per viewport — the peel engine turns one column
        // (one physical page of the spread), not the whole viewport.
        this.#pageColumns = divisor
        if (updateChrome) this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        if (updateChrome) {
            const marginalDivisor = vertical
                ? Math.min(2, Math.ceil(width / maxInlineSize))
                : divisor
            const marginalStyle = {
                gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
                gap: `${gap}px`,
                direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
            }
            Object.assign(this.#header.style, marginalStyle)
            Object.assign(this.#footer.style, marginalStyle)
            const heads = makeMarginals(marginalDivisor, 'head')
            const feet = makeMarginals(marginalDivisor, 'foot')
            this.heads = heads.map(el => el.children[0])
            this.feet = feet.map(el => el.children[0])
            this.#header.replaceChildren(...heads)
            this.#footer.replaceChildren(...feet)
        }

        return { height, width, margin, marginTop, marginBottom, marginLeft, marginRight, gap, columnWidth }
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => { if (!this.#locked) this.#scrollToAnchor(this.#anchor) },
        })
        this.#view.element.style.left = '0'
        this.#view.element.style.top = '0'
        this.#container.append(this.#view.element)
        return this.#view
    }
    async #ensurePeekView(direction) {
        const index = this.#adjacentIndex(direction)
        if (index == null || this.scrolled) return
        const existing = this.#peekView
        if (existing?.index === index && existing.direction === direction) {
            this.#positionPeekView()
            return
        }
        this.#destroyPeekView()
        const token = ++this.#peekLoadToken
        const peek = new View({
            container: this,
            onExpand: () => {},
        })
        peek.element.style.position = 'absolute'
        peek.element.style.top = '0'
        peek.element.style.left = '0'
        peek.element.style.pointerEvents = 'none'
        const src = await Promise.resolve(this.sections[index].load()).catch(() => null)
        if (token !== this.#peekLoadToken || !src) {
            peek.destroy()
            return
        }
        try {
            await peek.load(src, doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                    this.#applyStylesToDoc(doc)
                }
            }, ({ vertical, rtl }) => this.#computeLayout(vertical, rtl))
        } catch {
            peek.destroy()
            return
        }
        if (token !== this.#peekLoadToken) {
            peek.destroy()
            return
        }
        this.#peekView = { view: peek, index, direction }
        this.#container.append(peek.element)
        this.#positionPeekView()
    }
    #destroyPeekView() {
        this.#peekLoadToken += 1
        const peek = this.#peekView
        if (!peek) return
        peek.view.destroy()
        peek.view.element.remove()
        this.sections[peek.index]?.unload?.()
        this.#styleMap.delete(peek.view.document)
        this.#peekView = null
    }
    #positionPeekView() {
        const peek = this.#peekView
        if (!peek || this.scrolled) return
        const axis = this.#vertical ? 'top' : 'left'
        const cross = this.#vertical ? 'left' : 'top'
        const homeOffset = this.#container[this.scrollProp]
        const peekSize = Math.round(peek.view.element.getBoundingClientRect()[this.sideProp] / this.size)
        if (!peekSize) return
        const peekLastContentPage = Math.max(1, peekSize - 2)
        const startOffset = peek.direction > 0
            ? homeOffset
            : homeOffset - this.size - (peekLastContentPage * this.size)
        peek.view.element.style[axis] = `${startOffset}px`
        peek.view.element.style[cross] = '0px'
    }
    #syncPeekView() {
        if (this.scrolled || !this.#view) {
            this.#destroyPeekView()
            return
        }
        const atFirstContent = this.page <= this.#firstContentPage
        const atLastContent = this.page >= this.#lastContentPage
        if (atLastContent && this.#adjacentIndex(1) != null) {
            this.#ensurePeekView(1)
            return
        }
        if (atFirstContent && this.#adjacentIndex(-1) != null) {
            this.#ensurePeekView(-1)
            return
        }
        this.#destroyPeekView()
    }
    #beforeRender({ vertical, rtl, background }) {
        return this.#computeLayout(vertical, rtl, { updateChrome: true, background })
    }
    render() {
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        if (this.#peekView) {
            this.#peekView.view.render(this.#computeLayout(this.#vertical, this.#rtl))
            this.#positionPeekView()
        }
        // Skip re-anchoring during a page turn — the turn is actively setting
        // a new scroll position and re-anchoring would revert it.
        if (!this.#locked) this.#scrollToAnchor(this.#anchor)
        this.#invalidatePeelWarm()
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    // Paginated layout adds one padding page at each end.
    // Content pages occupy indices 1 .. pages-2.
    get #firstContentPage() { return 1 }
    get #lastContentPage() { return this.pages - 2 }
    get #contentPageCount() { return Math.max(0, this.pages - 2) }
    // ── Page-peel API (MER-171 v2) ────────────────────────────────────────
    // The owned peel engine (packages/ui pageCurl) drives turns through these
    // methods. Intra-section turns reveal the silently translated live
    // document; section-boundary turns reveal the preloaded peek view of the
    // adjacent section, which #positionPeekView places at exactly the padding
    // page offset the same translate reaches. When neither is ready,
    // canTurnPage() is false and the caller falls back to plain navigation.
    setCurlDelegate(delegate) {
        this.#curlDelegate = delegate ?? null
        if (!delegate) {
            this.#peelState = null
            this.#peelWarm = null
            return
        }
        this.#schedulePeelWarm()
    }
    // The loaded peek view for a boundary turn in `direction`, or null when
    // the peel cannot reveal it live (peek missing, still loading, built for
    // the other edge, or the reader is not on the section edge it covers).
    #peekReadyFor(direction) {
        const dirSign = direction === 'next' ? 1 : -1
        const peek = this.#peekView
        if (!peek || peek.direction !== dirSign) return null
        if (!peek.view?.document?.body) return null
        if (this.#adjacentIndex(dirSign) !== peek.index) return null
        if (dirSign > 0 && this.page < this.#lastContentPage) return null
        if (dirSign < 0 && this.page > this.#firstContentPage) return null
        return peek
    }
    canTurnPage(direction) {
        if (this.scrolled || !this.#view?.document) return false
        const first = 1, last = this.pages - 2
        if (direction === 'next' ? this.page < last : this.page > first) return true
        return this.#peekReadyFor(direction) != null
    }
    // Visible columns in the current layout (1 or 2). The peel engine sizes
    // its turning sheet to one column so spreads turn a single page.
    get pageColumns() {
        return this.#pageColumns
    }
    // The section document's real page color. The peel engine paints its
    // opaque paper layers with this so the turning sheet matches the page it
    // covers exactly — the host element's computed background can differ by a
    // theme tint from what the iframe actually renders.
    get contentBackground() {
        try {
            const doc = this.#view?.document
            return doc ? (getSafeBackground(doc) || null) : null
        } catch {
            return null
        }
    }
    // Translate the laid-out document to a page WITHOUT firing relocate — in
    // paginated mode only #scrollTo runs the bookkeeping, so a raw offset
    // assignment is silent by construction. Used for the live peel reveal.
    #peelTranslateTo(page) {
        const offset = this.size * (this.#rtl ? -page : page)
        this.#container[this.scrollProp] = offset
    }
    // Prepare a peel: hand over the warm front/back clones of the current
    // page and silently reveal the adjacent page underneath. Returns null
    // when the peel cannot run live (no warm clone yet, section edge,
    // scrolled flow) so the engine falls back to a direct commit.
    preparePeel(direction) {
        try {
            if (!this.#curlDelegate || this.scrolled || !this.#view?.document) return null
            if (this.#locked) return null
            if (!this.canTurnPage(direction)) return null
            const warm = this.#peelWarm
            if (!warm || warm.page !== this.page) return null
            // Relayouts that skip relocate (resize, setStyles, flow changes)
            // are hooked, but late reflows can slip through — verify the
            // captured geometry still matches before trusting the clones.
            const rect = this.#container.getBoundingClientRect()
            if (warm.pageW !== rect.width || warm.pageH !== rect.height
                || warm.size !== this.size || warm.pages !== this.pages) {
                this.#invalidatePeelWarm()
                return null
            }
            // Boundary turns translate onto the padding page, where the peek
            // view's adjacent-section content sits; intra-section turns onto
            // the neighbouring column. Same formula either way.
            const boundary = direction === 'next'
                ? this.page >= this.#lastContentPage
                : this.page <= this.#firstContentPage
            if (boundary && !this.#peekReadyFor(direction)) return null
            const target = direction === 'next' ? this.page + 1 : this.page - 1
            this.#peelState = { dir: direction, homePage: this.page, boundary }
            this.#peelWarm = null
            this.#peelTranslateTo(target)
            return { front: warm.front, back: warm.back, width: rect.width, height: rect.height }
        } catch {
            return null
        }
    }
    // Commit a prepared peel: the live document already shows the target
    // page, so this only runs the standard post-turn bookkeeping (relocate,
    // anchor, peek sync). Boundary commits load the adjacent section via
    // #goTo directly — next()/prev() would first scroll from the translated
    // padding page, visibly sliding into the peek — while the peek element
    // keeps showing the identical target content until the section settles.
    // Without a prepared peel it is a plain page turn.
    async commitPeel(direction) {
        const state = this.#peelState
        this.#peelState = null
        if (!state) return direction === 'next' ? this.next() : this.prev()
        if (state.boundary) {
            const dirSign = direction === 'next' ? 1 : -1
            const index = this.#adjacentIndex(dirSign)
            if (index == null) return
            await this.#goTo({ index, anchor: dirSign > 0 ? () => 0 : () => 1 })
            this.#schedulePeelWarm()
            return
        }
        const offset = this.size * (this.#rtl ? -this.page : this.page)
        this.#scrollBounds = [offset, this.atStart ? 0 : this.size, this.atEnd ? 0 : this.size]
        this.#afterScroll('page')
        this.#schedulePeelWarm()
    }
    // Cancel a prepared peel: silently translate back to the origin page.
    cancelPeel() {
        const state = this.#peelState
        this.#peelState = null
        if (!state) return
        this.#peelTranslateTo(state.homePage)
        this.#schedulePeelWarm()
    }
    // Build the warm current-page clones on idle; best-effort — a peel that
    // finds no warm clone falls back to direct navigation for that turn.
    #schedulePeelWarm() {
        if (!this.#curlDelegate || this.scrolled || this.#peelWarmScheduled) return
        this.#peelWarmScheduled = true
        const build = () => {
            this.#peelWarmScheduled = false
            try {
                if (!this.#curlDelegate || this.scrolled || !this.#view?.document) return
                const doc = this.#view.document
                const rect = this.#container.getBoundingClientRect()
                const opts = {
                    pageW: rect.width, pageH: rect.height,
                    size: this.size, pages: this.pages,
                }
                const front = this.#cloneDocPage(doc, this.page, opts)
                const back = this.#cloneDocPage(doc, this.page, opts)
                if (front && back) this.#peelWarm = { page: this.page, front, back, ...opts }
            } catch { /* warm clone build is best-effort */ }
        }
        if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 800 })
        else setTimeout(build, 60)
    }
    // Font, theme, viewport, and flow changes reflow the columns without
    // firing relocate; a clone captured under the old layout must never peel.
    #invalidatePeelWarm() {
        if (!this.#curlDelegate) return
        this.#peelWarm = null
        this.#schedulePeelWarm()
    }
    #cloneDocPage(doc, page, { pageW, pageH, size, pages }) {
        const wrapper = document.createElement('div')
        Object.assign(wrapper.style, {
            position: 'absolute', width: `${pageW}px`, height: `${pageH}px`,
            // Fall back to transparent (not white) so the peel engine's themed
            // backdrop shows through on dark/sepia rather than flashing white.
            overflow: 'hidden', background: getBackground(doc) || 'transparent',
        })
        const shadow = wrapper.attachShadow({ mode: 'open' })
        // Carry the section's stylesheets into the shadow scope so text fidelity
        // holds outside the iframe. Resolve <link> hrefs to absolute so relative
        // stylesheet/font URLs don't break against the parent document origin.
        for (const node of doc.head?.querySelectorAll('style, link[rel="stylesheet"]') ?? []) {
            const clone = node.cloneNode(true)
            if (clone.tagName === 'LINK' && node.href) clone.href = node.href
            shadow.appendChild(clone)
        }
        // Content page `page` lives at iframe-local column offset size*(page-1)
        // (paginated layout adds one leading padding page).
        const localOffset = size * (page - 1)
        const totalSize = pages * size
        const positioner = document.createElement('div')
        Object.assign(positioner.style, {
            position: 'absolute', top: '0', left: '0',
            transform: this.#vertical
                ? `translateY(${this.#rtl ? localOffset : -localOffset}px)`
                : `translateX(${this.#rtl ? localOffset : -localOffset}px)`,
        })
        // Column container reproduces the iframe's documentElement (column styles
        // are inline) but is widened so all columns are visible/translatable.
        const root = document.createElement('div')
        root.style.cssText = doc.documentElement.style.cssText
        root.style.setProperty('overflow', 'visible', 'important')
        root.style.setProperty('margin', '0', 'important')
        if (this.#vertical) {
            root.style.setProperty('width', `${pageW}px`, 'important')
            root.style.setProperty('height', `${totalSize}px`, 'important')
        } else {
            root.style.setProperty('width', `${totalSize}px`, 'important')
            root.style.setProperty('height', `${pageH}px`, 'important')
        }
        const bodyClone = doc.body.cloneNode(true)
        root.appendChild(bodyClone)
        positioner.appendChild(root)
        shadow.appendChild(positioner)
        return wrapper
    }
    #isPageAnchor(anchor) {
        return !!anchor && typeof anchor === 'object' && anchor.type === 'page'
            && Number.isFinite(anchor.page)
    }
    #getPreviewTransformValue(displacement = this.#swipePreview?.displacement ?? 0) {
        return this.#rtl ? displacement : -displacement
    }
    #applySwipePreviewTransform(displacement = this.#swipePreview?.displacement ?? 0) {
        const prop = this.#vertical ? 'translateY' : 'translateX'
        const transform = `${prop}(${this.#getPreviewTransformValue(displacement)}px)`
        if (this.#view?.element) this.#view.element.style.transform = transform
        if (this.#peekView?.view?.element) this.#peekView.view.element.style.transform = transform
    }
    #clearSwipePreviewTransform() {
        this.#view?.element?.style?.removeProperty('transform')
        this.#peekView?.view?.element?.style?.removeProperty('transform')
    }
    #clearSwipePreview() {
        this.#swipePreview = null
        this.#clearSwipePreviewTransform()
    }
    #cancelRunningAnimation(clearTransform = false) {
        if (this._animationSignal) {
            this._animationSignal.cancelled = true
            this._animationSignal = null
        }
        if (clearTransform) this.#clearSwipePreviewTransform()
    }
    async #cancelSwipePreview() {
        const preview = this.#swipePreview
        if (!preview) return
        if (Math.abs(preview.displacement) <= 1 || !this.hasAttribute('animated')) {
            this.#clearSwipePreview()
            return
        }
        this.#cancelRunningAnimation()
        const signal = { cancelled: false }
        this._animationSignal = signal
        const start = preview.displacement
        const { completed } = await animate(start, 0, 300, easeSpring, value => {
            if (!this.#swipePreview) return
            this.#swipePreview.displacement = value
            this.#applySwipePreviewTransform(value)
        }, signal)
        if (!completed) {
            this.#clearSwipePreview()
            return
        }
        this.#clearSwipePreview()
    }
    async #commitSwipePreview(forward) {
        this.#cancelRunningAnimation()
        this.#clearSwipePreview()
        // Let prev()/next() animate normally — the 300ms animation keeps
        // #locked=true, preventing re-anchor races that snap the page back.
        // This also gives swipe commit the same smooth finish as tap-to-turn.
        return forward ? await this.next() : await this.prev()
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const rawVelocity = this.#vertical ? vy : vx
        const velocity = Math.max(-SNAP_MAX_VELOCITY, Math.min(SNAP_MAX_VELOCITY, rawVelocity))
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page < this.#firstContentPage ? -1
                : page > this.#lastContentPage ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #clearTouchHoldTimer() {
        if (this.#touchHoldTimer) {
            clearTimeout(this.#touchHoldTimer)
            this.#touchHoldTimer = null
        }
    }
    #setTouchStateIdle() {
        this.dataset.touchState = TOUCH_STATE_IDLE
    }
    // MER-216 audit notes on the selection scroll pin:
    // - Page offsets are fractional (size = getBoundingClientRect) while Blink
    //   quantizes scrollLeft, so exact-equality checks never hold on Android.
    //   An "enforcement" write triggered by the mismatch alone is a REAL
    //   programmatic scroll; fired from the selectionchange that CREATES a
    //   long-press selection it lands mid-anchoring and corrupts the anchor at
    //   block boundaries (first word of a paragraph anchored at the paragraph
    //   END). WebKit preserves fractional offsets, compared equal, stayed
    //   clean — hence the Android-only symptom.
    // - Therefore: never write from pin creation; compute offsets from LIVE
    //   readback (not #scrollBounds, which goes stale when a touch cancels an
    //   animated turn); enforce only from scroll events, skipping sub-quantum
    //   deviations but still cancelling every real auto-scroll tick.
    #currentPageScrollOffset() {
        if (this.scrolled || !this.#container) return null
        const { scrollProp, size } = this
        if (size) return Math.round(this.#container[scrollProp] / size) * size
        const offset = this.#scrollBounds?.[0]
        return Number.isFinite(offset) ? offset : null
    }
    #snapContainerToPageBoundary() {
        const offset = this.#currentPageScrollOffset()
        if (offset == null) return
        const { scrollProp } = this
        if (Math.abs(this.#container[scrollProp] - offset) > 0.5)
            this.#container[scrollProp] = offset
    }
    #pinSelectionScroll() {
        if (this.scrolled || !this.#container) return
        if (this.#selectionScrollPin != null) return
        const offset = this.#currentPageScrollOffset()
        if (offset == null) return
        const { scrollProp } = this
        const current = this.#container[scrollProp]
        if (Math.abs(current - offset) <= 1.5) {
            // Already page-aligned within scroll quantization: adopt the
            // browser-coerced readback so future comparisons are exact, and
            // write NOTHING during the anchoring window.
            this.#selectionScrollPin = current
        } else {
            // Genuinely off-boundary (e.g. mid auto-scroll): target the page
            // boundary; the frame loop performs the corrective write after
            // Blink finishes anchoring this selection.
            this.#selectionScrollPin = offset
        }
        this.#startSelectionPinFrameLoop()
    }
    // Blink's selection auto-scroll ticks run AFTER scroll-event dispatch but
    // BEFORE paint, so a scroll-event-only revert loses every painted frame:
    // the neighbor column flashes into view mid-drag and extraction reads it.
    // Enforcing again in the rAF phase (after their tick, before paint) wins
    // the frame. The loop only runs while a pin exists and writes nothing
    // when already aligned.
    #startSelectionPinFrameLoop() {
        if (this.#selectionPinAlignRaf != null) return
        const tick = () => {
            if (this.#selectionScrollPin == null) {
                this.#selectionPinAlignRaf = null
                return
            }
            this.#enforceSelectionScrollPin()
            this.#selectionPinAlignRaf = requestAnimationFrame(tick)
        }
        this.#selectionPinAlignRaf = requestAnimationFrame(tick)
    }
    #clearSelectionScrollPin() {
        this.#selectionScrollPin = null
        if (this.#selectionPinAlignRaf != null) {
            cancelAnimationFrame(this.#selectionPinAlignRaf)
            this.#selectionPinAlignRaf = null
        }
    }
    #enforceSelectionScrollPin() {
        if (this.#selectionScrollPin == null || this.scrolled || !this.#container) return
        if (!this.#hasActiveSelection()) {
            this.#clearSelectionScrollPin()
            return
        }
        const { scrollProp } = this
        if (Math.abs(this.#container[scrollProp] - this.#selectionScrollPin) <= 0.5) return
        this.#container[scrollProp] = this.#selectionScrollPin
        // Adopt the coerced readback when the write landed on target, so the
        // next comparison is exact instead of perpetually off by a fraction.
        const readback = this.#container[scrollProp]
        if (Math.abs(readback - this.#selectionScrollPin) <= 1.5)
            this.#selectionScrollPin = readback
    }
    #setTouchOwnership(owner) {
        const state = this.#touchState
        if (!state) return
        if (state.owner === SELECTION_ACTIVE && owner !== SELECTION_ACTIVE) return
        state.owner = owner
        this.dataset.touchState = owner
        if (owner === TOUCH_SWIPE || owner === SELECTION_ACTIVE) this.#clearTouchHoldTimer()
        // A selection-owned gesture must never keep a swipe-preview transform:
        // residual translateX would displace the visible content relative to
        // the selection being anchored.
        if (owner === SELECTION_ACTIVE) this.#clearSwipePreview()
    }
    #syncTouchSelectionOwnership() {
        const state = this.#touchState
        if (!state) return false
        const hasSelection = this.#hasActiveSelection()
        if (!hasSelection) return false
        // Selection must outrank swipe once an active range exists in this touch sequence.
        if (state.owner !== SELECTION_ACTIVE) this.#setTouchOwnership(SELECTION_ACTIVE)
        return state.owner === SELECTION_ACTIVE
    }
    #onTouchStart(e) {
        // Edge touch hook — allows host to claim edge swipes (e.g. back gesture)
        if (this._edgeTouchCallback && e.touches?.length === 1) {
            const touch = e.touches[0]
            const rect = this.getBoundingClientRect()
            const localX = touch.clientX - rect.left
            const edge = localX < 30 ? 'left'
                : rect.width - localX < 30 ? 'right'
                : null
            if (edge && this._edgeTouchCallback(edge, e)) {
                this.#touchState = null
                this.#clearTouchHoldTimer()
                return
            }
        }
        this.#cancelRunningAnimation(true)
        const container = this.#container
        if (container && !this.scrolled && !this.#curlDelegate) {
            const { scrollProp, size } = this
            container[scrollProp] = Math.round(container[scrollProp] / size) * size
            // Cancelled animated turns never commit #scrollBounds; refresh it
            // here (restores 84c2ce5's invariant dropped by e5069c9) so
            // nothing downstream pins or snaps to a stale page offset.
            this.#scrollBounds =
                [container[scrollProp], this.atStart ? 0 : size, this.atEnd ? 0 : size]
            const hasPrev = this.page > this.#firstContentPage
                || this.#adjacentIndex(-1) != null
            const hasNext = this.page < this.#lastContentPage
                || this.#adjacentIndex(1) != null
            this.#swipePreview = {
                homeOffset: container[scrollProp],
                displacement: 0,
                maxBackward: hasPrev ? size : 0,
                maxForward: hasNext ? size : 0,
            }
        }
        this.#clearTouchHoldTimer()
        const touch = e.changedTouches[0]
        const rootStart = touch ? this.#touchRootClient(e, touch) : { x: null, y: null }
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            startX: touch?.screenX, startY: touch?.screenY,
            // Curl mode (MER-171 v2): the peel engine maps these against the
            // host's rect in the TOP document, but reading-surface touches
            // fire inside the section iframe whose client space is offset by
            // the container scroll (whole page-widths on later pages).
            // Convert to top-document client coords; drags starting on
            // interactive content never peel.
            startClientX: rootStart.x, startClientY: rootStart.y,
            curlBlocked: !!e.target?.closest?.(
                'a, button, input, textarea, select, [contenteditable]'),
            t: e.timeStamp,
            startTime: e.timeStamp,
            vx: 0, vy: 0,
            owner: TOUCH_PENDING,
            cornerDir: 0,
            cornerSince: 0,
            cornerTurnAt: 0,
        }
        this.#touchScrolled = false
        this.dataset.touchState = TOUCH_PENDING
        this.#touchHoldTimer = setTimeout(() => {
            const state = this.#touchState
            if (!state || state.owner !== TOUCH_PENDING) return
            this.#setTouchOwnership(SELECTION_PRIMED)
        }, TOUCH_SELECTION_HOLD_MS)
    }
    // Convert a touch's client coords to the TOP document's client space.
    // Events from the section iframe carry iframe-local coords; the iframe is
    // as wide as every laid-out column and slides under the finger when the
    // container scrolls (including the peel's silent translate), so a fresh
    // frame rect per event is the only stable mapping.
    #touchRootClient(e, touch) {
        const frame = (e.view ?? e.target?.ownerDocument?.defaultView)?.frameElement
        if (!frame) return { x: touch.clientX, y: touch.clientY }
        const rect = frame.getBoundingClientRect()
        return { x: touch.clientX + rect.left, y: touch.clientY + rect.top }
    }
    #resetTouchSelectionCornerHold() {
        if (!this.#touchState) return
        this.#touchState.cornerDir = 0
        this.#touchState.cornerSince = 0
    }
    #getTouchSelectionCornerDirection(touch) {
        const rect = this.#container.getBoundingClientRect()
        const cornerSize = Math.max(
            TOUCH_SELECTION_CORNER_MIN_PX,
            Math.min(
                TOUCH_SELECTION_CORNER_MAX_PX,
                Math.round(Math.min(rect.width, rect.height) * 0.14),
            ),
        )
        const inTopLeft =
            touch.clientX <= rect.left + cornerSize
            && touch.clientY <= rect.top + cornerSize
        const inBottomRight =
            touch.clientX >= rect.right - cornerSize
            && touch.clientY >= rect.bottom - cornerSize
        if (inTopLeft) return -1
        if (inBottomRight) return 1
        return 0
    }
    #maybeTurnTouchSelectionPage(touch, timeStamp) {
        const state = this.#touchState
        if (!state || this.#locked) return
        const dir = this.#getTouchSelectionCornerDirection(touch)
        if (!dir) {
            this.#resetTouchSelectionCornerHold()
            return
        }

        if (state.cornerDir !== dir) {
            state.cornerDir = dir
            state.cornerSince = timeStamp
            return
        }

        const heldFor = timeStamp - (state.cornerSince ?? timeStamp)
        if (heldFor < TOUCH_SELECTION_CORNER_HOLD_MS) return
        if (timeStamp - (state.cornerTurnAt ?? 0) < TOUCH_SELECTION_CORNER_COOLDOWN_MS) return

        state.cornerTurnAt = timeStamp
        state.cornerSince = timeStamp
        if (dir < 0) this.prev()
        else this.next()
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (!state) return
        if (state.pinched) return
        state.pinched = getViewportScale() > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const touch = e.changedTouches[0]
        if (!touch) return

        const selecting = this.#syncTouchSelectionOwnership()
        if (state.owner === SELECTION_ACTIVE) {
            // Merrilin (MER-54/MER-216): cross-page selection is disabled by
            // product decision — selection anchors to the visible page, so the
            // corner-hold auto page turn during selection is intentionally NOT
            // invoked (this.#maybeTurnTouchSelectionPage). Turning mid-selection
            // extended the selection into the next page in ways users could not
            // see or control.
            this.#resetTouchSelectionCornerHold()
            return
        }
        if (state.owner === SELECTION_PRIMED) {
            this.#resetTouchSelectionCornerHold()
            return
        }
        if (selecting) {
            this.#resetTouchSelectionCornerHold()
            return
        }

        this.#resetTouchSelectionCornerHold()
        if (isEditableTarget(e.target)) return

        const driftX = Math.abs(touch.screenX - state.startX)
        const driftY = Math.abs(touch.screenY - state.startY)

        // Prevent default early if horizontal movement is detected, even
        // below the drift threshold. On Android WebView, if we don't prevent
        // default on early touchmove events, the browser starts native
        // scrolling and later touchmove events become non-cancelable,
        // breaking our swipe handling entirely.
        if (driftX > 5 && driftX > driftY) {
            e.preventDefault()
        }

        if (driftX <= TOUCH_SELECTION_DRIFT_PX
            && driftY <= TOUCH_SELECTION_DRIFT_PX) return

        if (state.owner === TOUCH_PENDING) this.#setTouchOwnership(TOUCH_SWIPE)
        if (state.owner !== TOUCH_SWIPE) return

        e.preventDefault()
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = Math.max(e.timeStamp - state.t, 1)
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        if (this.#curlDelegate) {
            if (!state.curlBlocked) {
                const root = this.#touchRootClient(e, touch)
                this.#curlDelegate.onCurlDragMove?.({
                    startClientX: state.startClientX,
                    startClientY: state.startClientY,
                    clientX: root.x,
                    clientY: root.y,
                })
            }
            return
        }
        const preview = this.#swipePreview
        if (!preview) return
        const delta = this.#vertical ? dy : dx
        preview.displacement = Math.max(-preview.maxBackward, Math.min(
            preview.maxForward,
            preview.displacement + delta,
        ))
        this.#applySwipePreviewTransform(preview.displacement)
    }
    #hasActiveSelection() {
        // Check both the outer document and the iframe document for
        // an active range selection, since touchend target may be in either.
        if (hasRangeSelection(this)) return true
        try {
            const doc = this.#view?.document
            if (doc) {
                const sel = doc.getSelection?.()
                if (sel && !sel.isCollapsed && sel.rangeCount > 0
                    && sel.type === 'Range') return true
            }
        } catch { /* cross-origin iframe — ignore */ }
        return false
    }
    #onTouchEnd() {
        const state = this.#touchState
        this.#clearTouchHoldTimer()
        this.#resetTouchSelectionCornerHold()
        this.#touchScrolled = false
        if (!state) {
            this.#setTouchStateIdle()
            return
        }
        if ((state.owner === TOUCH_PENDING || state.owner === SELECTION_PRIMED)
            && this.#hasActiveSelection()) this.#setTouchOwnership(SELECTION_ACTIVE)
        const owner = state.owner
        const vx = state.vx
        const vy = state.vy
        this.#touchState = null
        this.#setTouchStateIdle()
        if (this.scrolled) return
        if (owner === SELECTION_ACTIVE || owner === SELECTION_PRIMED) {
            // Native selection auto-scroll can strand the container between
            // page boundaries while the finger drags near an edge (Merrilin
            // MER-216/MER-54: reader rested mid-page showing halves of two
            // columns). Snap back to the current page boundary whenever a
            // selection touch sequence ends.
            this.#snapContainerToPageBoundary()
            return
        }
        if (owner !== TOUCH_SWIPE) return

        // Use requestAnimationFrame to let the browser settle viewport
        // scale after pinch gestures before deciding on navigation.
        requestAnimationFrame(() => {
            if (getViewportScale() !== 1) return
            if (this.#curlDelegate) {
                if (!state.curlBlocked) this.#curlDelegate.onCurlDragEnd?.()
                return
            }

            const displacement = this.#swipePreview?.displacement ?? 0
            const absDisplacement = Math.abs(displacement)
            const { size } = this

            const velocity = this.#vertical ? Math.abs(vy) : Math.abs(vx)
            const shouldTurn = absDisplacement > size * 0.15 || velocity > 0.3

            if (shouldTurn && absDisplacement > 1) {
                const forward = (displacement > 0) !== this.#rtl
                this.#commitSwipePreview(forward)
            } else if (absDisplacement > 1) {
                this.#cancelSwipePreview()
            } else {
                this.#clearSwipePreview()
            }
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        const { scrollProp, size } = this
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        const animateScroll = (reason === 'snap' || smooth)
            && !this.#curlDelegate && this.hasAttribute('animated')
        if (animateScroll) {
            // Cancel any in-flight animation before starting a new one
            if (this._animationSignal) this._animationSignal.cancelled = true
            const signal = { cancelled: false }
            this._animationSignal = signal
            return animate(
                element[scrollProp], offset, 300, easeOutQuad,
                x => element[scrollProp] = x,
                signal,
            ).then(({ completed }) => {
                // Cancelled animations must not commit state — doing so
                // overwrites scrollBounds with stale values and corrupts
                // the next gesture.
                if (!completed) return
                this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
                this.#afterScroll(reason)
            })
        }
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        if (!this.scrolled && this.#isPageAnchor(anchor)) {
            const page = Math.max(this.#firstContentPage, Math.min(this.#lastContentPage, anchor.page))
            await this.#scrollToPage(page, reason)
            return
        }
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const count = this.#contentPageCount
        if (!count) return
        const newPage = Math.round(anchor * (count - 1))
        await this.#scrollToPage(newPage + this.#firstContentPage, reason)
    }
    #getVisibleRange() {
        if (!this.#view?.document) return
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        this.dataset.lastRelocateReason = reason ?? ''
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor') {
            // Page turns in paginated mode should restore the exact logical
            // page they landed on. Range anchors can drift when headings or
            // other block elements bleed across column boundaries.
            if (reason === 'page' && !this.scrolled) {
                this.#anchor = { type: 'page', page: this.page }
            } else {
                this.#anchor = range
            }
        }
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.#contentPageCount > 0) {
            const { page } = this
            const count = this.#contentPageCount
            const divisor = Math.max(1, count - 1)
            this.#header.style.visibility = page > this.#firstContentPage ? 'visible' : 'hidden'
            detail.fraction = (page - this.#firstContentPage) / divisor
            detail.size = 1 / count
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
        this.#syncPeekView()
        // The settled page becomes the next peel's warm current-page clone.
        if (this.#curlDelegate) {
            this.#peelWarm = null
            this.#schedulePeelWarm()
        }
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select}) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true)
            .then(() => page < this.#firstContentPage)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        return this.#scrollToPage(page, 'page', true)
            .then(() => page > this.#lastContentPage)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null
            && this.page <= this.#firstContentPage
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null
            && this.page >= this.#lastContentPage
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        try {
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) await this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: prev ? () => 1 : () => 0,
            })
            if (shouldGo) await wait(100)
            else if (!this.hasAttribute('animated')) await new Promise(r => requestAnimationFrame(r))
            // Let #afterScroll naturally update #anchor via the 'page'
            // reason (line 1219 excludes only anchor/selection/navigation).
            // The lock guards prevent the re-anchor loop from reverting
            // during the turn.  We just need to ensure afterScroll ran
            // so #anchor reflects the new position before we unlock.
        } catch (e) {
            console.error('[PAGINATOR] #turnPage error:', e)
        } finally {
            this.#locked = false
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    getVisibleRange() {
        return this.#getVisibleRange()
    }
    setStyles(styles) {
        this.#styles = styles
        if (this.#view?.document) this.#applyStylesToDoc(this.#view.document, styles)
        if (this.#peekView?.view?.document) this.#applyStylesToDoc(this.#peekView.view.document, styles)

        const currentView = this.#view
        const currentPeek = this.#peekView
        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() => {
            if (this.#view !== currentView) return
            const background = getSafeBackground(currentView?.document)
            if (background != null) this.#background.style.background = background
        })

        // needed because the resize observer doesn't work in Firefox
        currentView?.document?.fonts?.ready?.then(() => {
            if (this.#view !== currentView || !currentView?.document?.body) return
            currentView.expand()
        })
        currentPeek?.view?.document?.fonts?.ready?.then(() => {
            if (this.#peekView !== currentPeek || !currentPeek?.view?.document?.body) return
            currentPeek.view.expand()
            this.#positionPeekView()
        })
        this.#invalidatePeelWarm()
    }
    focusView() {
        this.#view?.document?.defaultView?.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#destroyPeekView()
        this.#view.destroy()
        this.#view = null
        this.sections[this.#index]?.unload?.()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
