// Visual editor webview. Receives a 'render' message with the element's view model and posts edit/navigation
// messages back; it never touches files itself.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v !== undefined && v !== null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  const go = (path) => path && send('navigate', { path });
  const button = (label, title, onClick, enabled = true) => h('button', { title, disabled: !enabled, on: { click: onClick } }, label);

  /** An input that commits on Enter/blur when changed; enumerations become a select. */
  function editor(value, allowed, commit, multiline) {
    if (allowed) return h('select', { on: { change: (e) => commit(e.target.value) } }, (allowed.includes(value) ? allowed : [value, ...allowed]).map((a) => h('option', { value: a, selected: a === value }, a)));
    const input = h(multiline ? 'textarea' : 'input', { rows: multiline ? Math.min(8, value.split('\n').length + 1) : undefined, on: {
      change: (e) => e.target.value !== value && commit(e.target.value),
      keydown: (e) => { if (e.key === 'Enter' && !multiline) e.target.blur(); if (e.key === 'Escape') { e.target.value = value; e.target.blur(); } },
    } });
    input.value = value;
    return input;
  }

  function navBar(s) {
    const n = s.nav;
    const crumbs = [];
    const parts = s.view.path.split('/').slice(1);
    parts.forEach((part, i) => crumbs.push(h('span', { class: 'sep' }, '/'), h('a', { href: '#', on: { click: (e) => { e.preventDefault(); go('/' + parts.slice(0, i + 1).join('/')); } } }, part)));
    return h('div', { class: 'nav' },
      button('←', 'Back (Alt+Left)', () => send('back'), n.canBack), button('→', 'Forward (Alt+Right)', () => send('forward'), n.canForward),
      button('↑', 'Parent (Alt+Up)', () => go(n.parent), !!n.parent), button('↓', 'First child (Alt+Down)', () => go(n.firstChild), !!n.firstChild),
      button('⇠', 'Previous sibling (Alt+Shift+Up)', () => go(n.prev), !!n.prev), button('⇢', 'Next sibling (Alt+Shift+Down)', () => go(n.next), !!n.next),
      h('span', { class: 'crumbs' }, crumbs),
      button('Open source', `Jump to ${s.view.source}`, () => send('source')), button('Reveal in tree', 'Select this element in the Tests tree', () => send('reveal')));
  }

  function header(s) {
    const v = s.view;
    const title = s.renamable ? editor(v.name, undefined, (name) => send('rename', { name })) : h('span', {}, v.name);
    title.classList.add('title');
    return h('header', {}, h('div', { class: 'kind' }, `${v.type ?? v.kind}`, s.generated ? h('span', { class: 'badge', title: s.generated.detail }, `test.h ${s.generated.status}`) : null), title,
      h('p', { class: 'what' }, s.description.what), (v.problems ?? []).map((p) => h('p', { class: 'problem' }, p)));
  }

  function fields(s) {
    const v = s.view;
    const rows = [];
    if (s.schema.value || v.kind === 'parameter') {
      const info = s.schema.value ?? { type: 'not set', editable: true };
      rows.push(h('tr', {}, h('th', {}, 'Value'), h('td', {}, info.editable ? editor(v.value ?? '', info.allowed, (value) => send('set', { target: v.path, value }), (v.value ?? '').includes('\n')) : h('code', {}, v.value ?? '')), h('td', { class: 'type' }, [info.type, info.doc].filter(Boolean).join(' — '))));
    }
    for (const f of s.schema.fields) rows.push(h('tr', {}, h('th', {}, f.name), h('td', {}, editor(f.value, f.allowed, (value) => send('set', { target: `${v.path}/@${f.name}`, value }), f.value.includes('\n'))), h('td', { class: 'type' }, f.type)));
    for (const a of s.schema.attributes) rows.push(h('tr', {}, h('th', {}, '@' + a.name), h('td', {}, a.editable ? editor(a.value, a.allowed, (value) => send('set', { target: `${v.path}/@${a.name}`, value })) : h('code', {}, a.value)), h('td', { class: 'type' }, a.editable ? 'attribute' : 'attribute (read-only)')));
    return rows.length ? h('section', {}, h('h3', {}, 'Values'), h('table', {}, rows)) : null;
  }

  function children(s) {
    const rows = s.children.map((c) => h('tr', { class: c.missing ? 'missing' : '' },
      h('td', {}, h('a', { href: '#', on: { click: (e) => { e.preventDefault(); go(c.path); } } }, c.name)), h('td', { class: 'type' }, c.type), h('td', { class: 'value' }, c.missing ? 'missing file' : c.value ?? ''),
      h('td', { class: 'actions' }, button('▲', 'Move up', () => send('moveUp', { path: c.path }), c.canUp), button('▼', 'Move down', () => send('moveDown', { path: c.path }), c.canDown), button('✕', 'Delete', () => send('delete', { path: c.path }), c.removable))));
    return h('section', {}, h('h3', {}, `Children (${s.children.length})`), rows.length ? h('table', { class: 'children' }, rows) : h('p', { class: 'hint' }, 'No children.'), adders(s));
  }

  function adders(s) {
    const out = [];
    const types = s.schema.allowedChildren;
    if (types.length) {
      const type = h('select', {}, types.map((t) => h('option', { value: t.type }, `${t.title} (${t.type})`)));
      const name = h('input', {});
      const value = h('input', {});
      const hint = h('p', { class: 'hint' });
      const sync = () => {
        const t = types.find((x) => x.type === type.value);
        name.placeholder = t.name ?? 'name: not used';
        name.disabled = !t.name;
        value.placeholder = t.value ?? 'value: not used';
        value.disabled = !t.value;
        hint.textContent = t.doc;
      };
      type.addEventListener('change', sync);
      sync();
      out.push(h('div', { class: 'adder' }, h('b', {}, 'Add step'), type, name, value, button('Add', 'Append the step', () => send('addStep', { stepType: type.value, name: name.value, value: value.value }))), hint);
    }
    if (s.context.includes('packageRef') || s.context.startsWith('package')) {
      const name = h('input', { placeholder: 'name' });
      const value = h('input', { placeholder: 'default value' });
      const dir = h('select', {}, ['in', 'out', 'local'].map((d) => h('option', { value: d }, d)));
      out.push(h('div', { class: 'adder' }, h('b', {}, 'Add variable'), name, value, dir, button('Add', 'Add a parameter, return value or local variable', () => send('addParam', { name: name.value, value: value.value, direction: dir.value }))));
    }
    if (s.context.includes('packages')) {
      const file = h('input', { placeholder: 'Folder/Package.pkg (relative to the project folder)' });
      const name = h('input', { placeholder: 'test case name (optional)' });
      out.push(h('div', { class: 'adder' }, h('b', {}, 'Add package'), file, name, button('Add', 'Reference the package; creates it if missing', () => send('addPackage', { file: file.value, name: name.value }))));
    }
    return out;
  }

  function details(s) {
    const d = s.description;
    const refs = d.references.map((r) => h('li', {}, `${r.label}: `, h('a', { href: '#', on: { click: (e) => { e.preventDefault(); go(r.path); } } }, r.path)));
    return h('section', { class: 'details' }, d.generated.length ? [h('h3', {}, 'test.h'), h('ul', {}, d.generated.map((g) => h('li', {}, g)))] : null, refs.length ? [h('h3', {}, 'References'), h('ul', {}, refs)] : null);
  }

  function render(s) {
    state = s;
    app.replaceChildren(navBar(s), header(s), fields(s) ?? '', children(s), details(s));
  }

  window.addEventListener('message', (e) => {
    if (e.data.type === 'render') render(e.data);
    if (e.data.type === 'empty') app.replaceChildren(h('p', { class: 'hint' }, 'No ECU-TEST project loaded.'));
  });
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !state) return;
    const n = state.nav;
    const target = { ArrowLeft: () => send('back'), ArrowRight: () => send('forward'), ArrowUp: () => go(e.shiftKey ? n.prev : n.parent), ArrowDown: () => go(e.shiftKey ? n.next : n.firstChild) }[e.key];
    if (target) {
      e.preventDefault();
      target();
    }
  });
})();
