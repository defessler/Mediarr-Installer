// Builds the static docs site: content/*.md -> _site/**/index.html
//
// Deliberately small and dependency-light. Two build deps (marked for
// markdown, highlight.js for code) and nothing at runtime except the
// Mermaid script on pages that actually draw a diagram. No framework, no
// Ruby, no watch server. `npm run build` and you have a directory of
// plain HTML that a static host serves as-is.
//
// Page metadata lives in each markdown file's frontmatter rather than in
// a central manifest, so a page carries its own title, nav placement and
// ordering. Adding a page means adding one file.

import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import hljs from 'highlight.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CONTENT = join(ROOT, 'content')
const OUT = join(ROOT, '_site')
const TEMPLATE = join(ROOT, 'templates', 'page.html')

// Pinned so a Mermaid major bump can't silently restyle or break every
// diagram on the site. Bump deliberately after checking the rendering.
const MERMAID_VERSION = '11.4.1'

// ── frontmatter ──────────────────────────────────────────────────────
// A tiny `key: value` parser rather than a YAML dependency. Values are
// plain scalars; `true`/`false` and integers are coerced, everything
// else stays a string with surrounding quotes stripped.
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: raw }
  const block = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const meta = {}
  for (const line of block.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf(':')
    if (i === -1) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (val === 'true') val = true
    else if (val === 'false') val = false
    else if (/^-?\d+$/.test(val)) val = Number(val)
    meta[key] = val
  }
  return { meta, body }
}

// ── slug / escaping helpers ──────────────────────────────────────────
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** GitHub-ish heading slug. Collisions get -2, -3, … so in-page anchors
 *  stay unique on a long page with repeated section names. */
function makeSlugger() {
  const seen = new Map()
  return (text) => {
    const base = String(text)
      .replace(/<[^>]+>/g, '')
      // Decode first. The text arrives as rendered HTML, so an apostrophe
      // is "&#39;" — slugging that directly leaves the digits behind and
      // "What you'll learn" anchors as #what-you39ll-learn.
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      // One hyphen per whitespace CHARACTER, not per run, and no
      // collapsing afterwards. This mirrors GitHub's slugger exactly.
      // "Chapter 0 — Prerequisites" loses the dash to the strip above,
      // leaving two spaces, so GitHub anchors it #chapter-0--prerequisites
      // with the double hyphen. Pages ported from the wiki carry
      // hand-written tables of contents with those anchors baked in, so
      // tidying the slug here silently breaks every one of them.
      .replace(/\s/g, '-') || 'section'
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  }
}

// ── markdown -> html ─────────────────────────────────────────────────
function renderMarkdown(md, { slugger, toc, onMermaid }) {
  const marked = new Marked({ gfm: true, breaks: false })

  marked.use({
    renderer: {
      code(token) {
        // marked v15 hands the renderer a token object; older shapes
        // passed positional args. Accept both so a dependency bump
        // doesn't silently emit unhighlighted blocks.
        const text = typeof token === 'object' ? token.text : arguments[0]
        const lang = (typeof token === 'object' ? token.lang : arguments[1]) || ''
        const language = String(lang).trim().split(/\s+/)[0].toLowerCase()

        // Mermaid stays as source for the browser to draw. Wrapped so it
        // gets the same panel treatment as a code block, and flagged so
        // the page only loads the Mermaid script when one is present.
        if (language === 'mermaid') {
          onMermaid()
          return `<div class="mermaid-wrap"><pre class="mermaid">${escapeHtml(text)}</pre></div>\n`
        }

        let body
        if (language && hljs.getLanguage(language)) {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value
        } else {
          body = escapeHtml(text)
        }
        const cls = language ? ` class="language-${escapeHtml(language)} hljs"` : ' class="hljs"'
        return `<pre><code${cls}>${body}</code></pre>\n`
      },

      heading(token) {
        const depth = typeof token === 'object' ? token.depth : arguments[1]
        const inline = typeof token === 'object'
          ? this.parser.parseInline(token.tokens)
          : arguments[0]
        // h1 is the page title, rendered from frontmatter, so a markdown
        // h1 would duplicate it. Only h2/h3 get anchors and TOC entries.
        if (depth === 1) return `<h1>${inline}</h1>\n`
        const id = slugger(inline.replace(/<[^>]+>/g, ''))
        if (depth === 2 || depth === 3) {
          toc.push({ depth, id, text: inline.replace(/<[^>]+>/g, '') })
        }
        return `<h${depth} id="${id}">${inline}</h${depth}>\n`
      },
    },
  })

  return marked.parse(md)
}

/** Promote `IMPORTANT:` / `Note:` paragraphs into styled callouts.
 *  The house style writes them as a bare label plus colon at the start
 *  of a paragraph (no blockquote syntax), so this is where that
 *  convention becomes visual. */
function promoteCallouts(html) {
  return html.replace(
    /<p>(IMPORTANT|Note):\s*([\s\S]*?)<\/p>/g,
    (_m, label, rest) => {
      const kind = label === 'IMPORTANT' ? 'important' : 'note'
      return `<div class="callout callout-${kind}">` +
        `<p><span class="callout-label">${label}:</span> ${rest}</p></div>`
    },
  )
}

/** Give every table its own horizontal scroll container. A wide table
 *  must scroll inside its own box rather than making the whole page
 *  scroll sideways on a phone. */
function wrapTables(html) {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (t) => `<div class="table-wrap">${t}</div>`)
}

/** Rewrite links between content pages. Authors write `[x](tutorial)` or
 *  the wiki's `[x](Tutorial)`; both resolve to the built path. Anything
 *  absolute or anchored is left alone. */
function rewriteLinks(html, pagesBySlug, rootPrefix, broken, sourceName) {
  return html.replace(/href="([^"#?][^"]*)"/g, (full, href) => {
    if (/^(https?:|mailto:|#|\/)/i.test(href)) return full
    // Accept every form an author might reasonably write: `tutorial`,
    // `tutorial.md`, `./tutorial`, and the already-built `tutorial/`.
    // All normalize to the same key and re-emit as the canonical path,
    // so the rewrite is idempotent.
    const clean = href
      .replace(/\.md$/i, '')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
    const key = clean.toLowerCase()
    if (pagesBySlug.has(key)) {
      const p = pagesBySlug.get(key)
      return `href="${rootPrefix}${p.slug === 'index' ? '' : p.slug + '/'}"`
    }
    // Every non-absolute link in this content set is meant to point at
    // another page here. One that resolves to nothing is link rot —
    // usually a page that got renamed or removed and left referrers
    // behind. Collect it and fail the build rather than shipping a 404.
    broken.push(`${sourceName} -> ${href}`)
    return full
  })
}

function renderToc(toc) {
  if (toc.length < 3) return ''
  // h.text is captured from marked's already-rendered inline HTML with
  // tags stripped, so its entities are escaped once already. Escaping
  // again here turns an apostrophe into a literal "&#39;" on the page.
  const items = toc.map((h) =>
    `<li class="toc-h${h.depth}"><a href="#${h.id}">${h.text}</a></li>`,
  ).join('\n')
  return `<ol>\n${items}\n</ol>`
}

/** The one navigation rail, holding two different things.
 *
 *  These are two separate axes: where you are IN THE PAGE, and where you
 *  are IN THE DOCS. Stacking them meant the longer one buried the other
 *  — the tutorial's 32-entry contents list pushed every guide link off
 *  the bottom of a sticky, scrolling column. Putting them back on
 *  opposite edges isn't the answer either; that surrounds the reader
 *  with navigation.
 *
 *  So they share the rail by switching rather than by stacking. Both are
 *  one click away, and neither can ever hide the other however long
 *  either grows.
 *
 *  Implemented with hidden radio inputs and sibling selectors rather
 *  than JavaScript, so the tabs work with scripting blocked. Without
 *  CSS, both panels simply render in sequence, which is the old
 *  behaviour and still perfectly usable. */
function renderSidebar(pages, current, rootPrefix, toc) {
  const groups = new Map()
  for (const p of pages) {
    if (!p.meta.group) continue
    if (!groups.has(p.meta.group)) groups.set(p.meta.group, [])
    groups.get(p.meta.group).push(p)
  }
  const order = ['Getting started', 'Understanding it', 'Using your stack', 'Music']
  const sorted = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  const blocks = sorted.map((g) => {
    const items = groups.get(g)
      .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99))
      .map((p) => {
        const href = `${rootPrefix}${p.slug === 'index' ? '' : p.slug + '/'}`
        const active = p.slug === current ? ' class="active"' : ''
        return `<li><a href="${href}"${active}>${escapeHtml(p.meta.title)}</a></li>`
      }).join('\n')
    return `<div class="side-group"><div class="side-title">${escapeHtml(g)}</div><ul>\n${items}\n</ul></div>`
  }).join('\n')

  const tocList = renderToc(toc)
  const guides = `<div class="rail-panel rail-guides">${blocks}</div>`

  // A short page has no contents worth listing, so it gets the guide
  // list outright with no tab strip to click past.
  if (!tocList) {
    return '<nav class="docs-sidebar docs-sidebar-single" aria-label="Documentation">\n'
      + guides + '\n</nav>'
  }

  // Contents is the default tab: you just navigated here, so you know
  // where you are in the docs, and what you want next is the shape of
  // the page in front of you.
  return '<nav class="docs-sidebar" aria-label="Documentation">\n'
    + '<input type="radio" name="rail" id="rail-toc" class="rail-radio" checked>\n'
    + '<input type="radio" name="rail" id="rail-guides" class="rail-radio">\n'
    + '<div class="rail-tabs">'
    + '<label for="rail-toc">On this page</label>'
    + '<label for="rail-guides">All guides</label>'
    + '</div>\n'
    + `<div class="rail-panel rail-toc docs-toc">${tocList}</div>\n`
    + guides + '\n</nav>'
}

function renderNav(pages, current, rootPrefix) {
  return pages
    .filter((p) => p.meta.nav)
    .sort((a, b) => (a.meta.navOrder ?? 99) - (b.meta.navOrder ?? 99))
    .map((p) => {
      const href = `${rootPrefix}${p.slug === 'index' ? '' : p.slug + '/'}`
      const active = p.slug === current ? ' class="active"' : ''
      return `      <li><a href="${href}"${active}>${escapeHtml(p.meta.nav)}</a></li>`
    })
    .join('\n')
}

function renderPager(pages, current, rootPrefix) {
  const flow = pages
    .filter((p) => p.meta.group)
    .sort((a, b) => {
      const order = ['Getting started', 'Understanding it', 'Using your stack', 'Music']
      const ga = order.indexOf(a.meta.group), gb = order.indexOf(b.meta.group)
      if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb)
      return (a.meta.order ?? 99) - (b.meta.order ?? 99)
    })
  const i = flow.findIndex((p) => p.slug === current)
  if (i === -1) return ''
  const prev = flow[i - 1], next = flow[i + 1]
  const link = (p, cls) =>
    `<a class="${cls}" href="${rootPrefix}${p.slug === 'index' ? '' : p.slug + '/'}">${escapeHtml(p.meta.title)}</a>`
  return '<div class="doc-pager">' +
    (prev ? link(prev, 'pager-prev') : '<span></span>') +
    '<span class="pager-spacer"></span>' +
    (next ? link(next, 'pager-next') : '<span></span>') +
    '</div>'
}

/** The Mermaid loader, themed to the Monokai palette.
 *
 *  The config is emitted inline rather than read off a global set by
 *  site.js, so diagram styling can't depend on script execution order.
 *  Left on its default theme, Mermaid draws lavender boxes on white,
 *  which would be the one un-themed thing on the site. */
function mermaidScript() {
  const config = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      darkMode: true,
      background: '#141414',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      // Diagram labels are read at a glance, unlike prose, so they run
      // larger than body text rather than smaller.
      fontSize: '15px',

      // Nodes sit lighter than the panel they're on, with a cyan border
      // rather than the muted brown one. On a dark diagram a low-contrast
      // border makes the boxes dissolve into the background.
      primaryColor: '#39392f',
      primaryTextColor: '#FFFFFF',
      primaryBorderColor: '#66D9EF',
      secondaryColor: '#2d2d2d',
      secondaryTextColor: '#FFFFFF',
      secondaryBorderColor: '#66D9EF',
      tertiaryColor: '#2d2d2d',
      tertiaryTextColor: '#FFFFFF',
      tertiaryBorderColor: '#66D9EF',

      lineColor: '#BFBBAA',
      textColor: '#FFFFFF',
      mainBkg: '#39392f',
      nodeBorder: '#66D9EF',
      nodeTextColor: '#FFFFFF',
      clusterBkg: 'rgba(166, 226, 46, 0.10)',
      clusterBorder: '#A6E22E',
      titleColor: '#A6E22E',
      edgeLabelBackground: '#141414',

      // Sequence diagrams
      actorBkg: '#2d2d2d',
      actorBorder: '#66D9EF',
      actorTextColor: '#F8F8F2',
      actorLineColor: '#75715E',
      signalColor: '#F8F8F2',
      signalTextColor: '#F8F8F2',
      labelBoxBkgColor: '#2d2d2d',
      labelBoxBorderColor: '#49483E',
      labelTextColor: '#F8F8F2',
      loopTextColor: '#E6DB74',
      noteBkgColor: '#141414',
      noteBorderColor: '#E6DB74',
      noteTextColor: '#E6DB74',
      activationBkgColor: '#49483E',
      activationBorderColor: '#75715E',
    },
    // htmlLabels off: securityLevel 'strict' sanitizes embedded HTML
    // anyway, and plain SVG text labels inherit the page font cleanly.
    // useMaxWidth on: Mermaid scales the SVG to fit the column. That
    // shrinks label text along with it, so the real fix for legibility
    // is keeping each diagram NARROW enough that the scale factor stays
    // near 1 — vertical layouts, short labels, few nodes per rank —
    // rather than turning scaling off and trading unreadable text for a
    // horizontal scrollbar.
    flowchart: {
      curve: 'basis', useMaxWidth: true, htmlLabels: false,
      padding: 16, nodeSpacing: 50, rankSpacing: 65,
      // A subgraph title that wraps to two lines otherwise overlaps the
      // first node inside it. Mermaid reserves no room for the second
      // line without this.
      subGraphTitleMargin: { top: 6, bottom: 18 },
    },
    // showSequenceNumbers must stay on: the prose refers to steps by
    // number ("if step 8 never happens"), and this setting overrides the
    // diagram's own `autonumber` directive.
    sequence: { useMaxWidth: true, showSequenceNumbers: true, mirrorActors: false },
  }
  return `<script type="module">\n` +
    `  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs';\n` +
    `  mermaid.initialize(${JSON.stringify(config)});\n` +
    `  await mermaid.run({ querySelector: '.mermaid' });\n` +
    `</script>`
}

// ── walk content ─────────────────────────────────────────────────────
async function collect(dir, base = '') {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await collect(full, base ? `${base}/${e.name}` : e.name)))
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const raw = await readFile(full, 'utf8')
      const { meta, body } = parseFrontmatter(raw)
      const name = e.name.replace(/\.md$/, '')
      const slug = meta.slug ?? (name === 'index' ? 'index' : name)
      out.push({ slug, meta, body, source: relative(CONTENT, full).split(sep).join('/') })
    }
  }
  return out
}

async function main() {
  if (!existsSync(CONTENT)) {
    console.error('No content/ directory — nothing to build.')
    process.exit(1)
  }

  const template = await readFile(TEMPLATE, 'utf8')
  const pages = await collect(CONTENT)
  if (!pages.length) {
    console.error('content/ has no .md files.')
    process.exit(1)
  }

  // Fail loudly on a missing title rather than emitting a page titled
  // "undefined" that nobody notices until it's live.
  const untitled = pages.filter((p) => !p.meta.title)
  if (untitled.length) {
    console.error('Missing `title` in frontmatter:\n  ' +
      untitled.map((p) => p.source).join('\n  '))
    process.exit(1)
  }

  const pagesBySlug = new Map()
  for (const p of pages) {
    pagesBySlug.set(p.slug.toLowerCase(), p)
    // Wiki-style link targets ("Playlist-Sync") resolve to the same page,
    // so content ported from the wiki keeps working unedited.
    pagesBySlug.set(p.slug.replace(/-/g, '').toLowerCase(), p)
    if (p.meta.title) pagesBySlug.set(String(p.meta.title).replace(/\s+/g, '-').toLowerCase(), p)
    // `aliases:` carries the page's old names. A page renamed on the way
    // over from the wiki still answers to what every existing link calls
    // it, so porting doesn't mean editing every referrer.
    if (p.meta.aliases) {
      for (const a of String(p.meta.aliases).split(',')) {
        const key = a.trim().toLowerCase()
        if (key) pagesBySlug.set(key, p)
      }
    }
  }

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const broken = []
  const badAnchors = []
  let count = 0
  for (const page of pages) {
    const isHome = page.slug === 'index'
    const rootPrefix = isHome ? '' : '../'

    const slugger = makeSlugger()
    const toc = []
    let usesMermaid = false
    let html = renderMarkdown(page.body, {
      slugger, toc, onMermaid: () => { usesMermaid = true },
    })
    html = promoteCallouts(html)
    html = wrapTables(html)
    html = rewriteLinks(html, pagesBySlug, rootPrefix, broken, page.source)

    let body
    if (page.meta.layout === 'home') {
      body = `<main id="main" class="home">\n${html}\n</main>`
    } else {
      const lede = page.meta.lede
        ? `<p class="doc-lede">${escapeHtml(page.meta.lede)}</p>`
        : ''
      body = '<div class="docs">\n' +
        renderSidebar(pages, page.slug, rootPrefix, toc) + '\n' +
        `<main id="main" class="doc-content">\n` +
        `<h1>${escapeHtml(page.meta.title)}</h1>\n${lede}\n${html}\n` +
        renderPager(pages, page.slug, rootPrefix) +
        `</main>\n</div>`
    }

    // Mermaid is only pulled in on pages that actually draw something,
    // so the guides stay a single stylesheet and a 1 KB script.
    const mermaid = usesMermaid ? mermaidScript() : ''

    const out = template
      .replaceAll('{{TITLE}}', escapeHtml(
        isHome ? page.meta.title : `${page.meta.title} · Mediarr`))
      .replaceAll('{{DESCRIPTION}}', escapeHtml(page.meta.description ?? page.meta.lede ?? ''))
      .replaceAll('{{ROOT}}', rootPrefix)
      // Every path on the site is relative, so it works unchanged whether
      // it's served from a domain root or from a project subpath like
      // /Mediarr-Installer/. On the home page rootPrefix is empty, and a
      // bare href="" is a same-page link rather than a link home, so use
      // an explicit "./" there.
      .replaceAll('{{HOME}}', rootPrefix || './')
      .replaceAll('{{NAVLINKS}}', renderNav(pages, page.slug, rootPrefix))
      .replaceAll('{{BODY}}', body)
      .replaceAll('{{MERMAID}}', mermaid)

    // In-page anchors, checked against the finished HTML so it covers
    // hand-written tables of contents in the markdown as well as the
    // generated TOC. Ported pages carry GitHub-flavoured anchors baked
    // into their own contents lists, and a slugger that disagrees with
    // GitHub by one character breaks all of them at once, silently.
    const ids = new Set([...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))
    for (const m of out.matchAll(/href="#([^"]+)"/g)) {
      if (!ids.has(m[1])) badAnchors.push(`${page.source} -> #${m[1]}`)
    }

    const dest = isHome ? join(OUT, 'index.html') : join(OUT, page.slug, 'index.html')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, out, 'utf8')
    count++
  }

  await cp(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true })
  // Tells GitHub Pages to serve the directory as-is instead of running it
  // through Jekyll, which would otherwise skip files beginning with _.
  await writeFile(join(OUT, '.nojekyll'), '', 'utf8')

  if (badAnchors.length) {
    console.error(`\n${badAnchors.length} in-page anchor(s) point at no heading:`)
    for (const a of [...new Set(badAnchors)]) console.error(`  ${a}`)
    console.error('\nUsually a heading was renamed, or the slug rules drifted ' +
      "from GitHub's (which is what ported contents lists assume).")
    process.exit(1)
  }

  if (broken.length) {
    console.error(`\n${broken.length} unresolved internal link(s):`)
    for (const b of [...new Set(broken)]) console.error(`  ${b}`)
    console.error('\nEach points at a page that does not exist. Fix the link ' +
      'or add the page.')
    process.exit(1)
  }

  console.log(`Built ${count} pages -> ${relative(process.cwd(), OUT) || '_site'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
