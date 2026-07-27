// Progressive enhancement only. Every page is complete and readable
// with this file blocked: the nav is a plain list, the sidebar is a
// plain list, and the TOC links are ordinary anchors. This adds the
// mobile menu and the reading-position highlight, nothing structural.

(function () {
  'use strict'

  // ── Mobile nav ─────────────────────────────────────────────────────
  const nav = document.getElementById('site-nav')
  const toggle = document.getElementById('nav-toggle')

  if (nav && toggle) {
    const close = () => {
      if (!nav.classList.contains('nav-open')) return
      nav.classList.remove('nav-open')
      // Let the CRT close animation finish before the menu disappears.
      nav.classList.add('nav-closing')
      toggle.setAttribute('aria-expanded', 'false')
      window.setTimeout(() => nav.classList.remove('nav-closing'), 150)
    }

    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('nav-open')
      nav.classList.remove('nav-closing')
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    })

    // Escape closes it, matching what a keyboard user expects from a
    // disclosure, and returns focus to the control that opened it.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
        close()
        toggle.focus()
      }
    })

    // Tapping a link navigates away, but on an in-page anchor it
    // wouldn't, and the menu would sit there covering the target.
    nav.addEventListener('click', (e) => {
      if (e.target.closest('#nav-links a')) close()
    })
  }

  // ── Sidebar on small screens ───────────────────────────────────────
  // Below the 900px breakpoint the sidebar stacks above the article,
  // where a full guide list is a wall the reader has to scroll past to
  // reach the page they already chose. Collapse it into a <details>,
  // but only at that width, and restore it on resize.
  const sidebar = document.querySelector('.docs-sidebar')
  if (sidebar) {
    const mq = window.matchMedia('(max-width: 900px)')
    let wrapped = null

    const collapse = () => {
      if (wrapped) return
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      // The rail is tabbed, holding both the page contents and the guide
      // list, so name it for the whole thing rather than either half.
      summary.textContent = 'Navigation'
      summary.style.cssText =
        'cursor:pointer;color:var(--mk-comment);font-size:0.8rem;padding:0.5rem 0;list-style:none'
      details.appendChild(summary)
      while (sidebar.firstChild) details.appendChild(sidebar.firstChild)
      sidebar.appendChild(details)
      wrapped = details
    }

    const expand = () => {
      if (!wrapped) return
      while (wrapped.firstChild) {
        if (wrapped.firstChild.tagName === 'SUMMARY') { wrapped.removeChild(wrapped.firstChild); continue }
        sidebar.appendChild(wrapped.firstChild)
      }
      wrapped.remove()
      wrapped = null
    }

    const sync = () => (mq.matches ? collapse() : expand())
    sync()
    mq.addEventListener('change', sync)
  }

  // ── TOC reading position ───────────────────────────────────────────
  const tocLinks = Array.from(document.querySelectorAll('.docs-toc a'))
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map()
    const headings = []
    for (const a of tocLinks) {
      const id = decodeURIComponent(a.getAttribute('href').slice(1))
      const el = document.getElementById(id)
      if (!el) continue
      byId.set(id, a)
      headings.push(el)
    }

    let activeId = null
    const setActive = (id) => {
      if (id === activeId) return
      if (activeId && byId.has(activeId)) byId.get(activeId).classList.remove('active')
      activeId = id
      if (id && byId.has(id)) byId.get(id).classList.add('active')
    }

    // Track which headings are above the fold rather than which are
    // merely visible: with a long section the heading scrolls off and no
    // entry intersects, which would clear the highlight entirely.
    const seen = new Set()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen.add(entry.target.id)
        else seen.delete(entry.target.id)
      }
      const first = headings.find((h) => seen.has(h.id))
      if (first) {
        setActive(first.id)
      } else {
        // Nothing in view: highlight the last heading scrolled past.
        const y = window.scrollY + 100
        let passed = null
        for (const h of headings) {
          if (h.getBoundingClientRect().top + window.scrollY <= y) passed = h.id
          else break
        }
        setActive(passed)
      }
    }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 })

    headings.forEach((h) => observer.observe(h))
  }
})()
