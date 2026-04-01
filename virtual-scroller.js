/**
 * virtual-scroller.js — Virtual Scroller optimizado para 1M filas
 *
 * Estrategia:
 *   • Solo renderiza las filas visibles + un overscan de ±OVERSCAN filas.
 *   • Recicla nodos DOM (pool de <tr>) para evitar creación/destrucción continua.
 *   • El contenedor tiene un "spacer" que da la altura total ficticia,
 *     y las filas reales se posicionan con transform:translateY().
 *   • Soporte para selección individual, rango (shift+click) y "seleccionar primeros N".
 *
 * Uso:
 *   const vs = new VirtualScroller(containerEl, { rowHeight:40, overscan:5 });
 *   vs.setData(rows, renderRow);
 *   vs.onSelectionChange = (selectedIds) => { ... };
 */

const OVERSCAN = 8; // filas extra arriba/abajo para suavizar el scroll

export class VirtualScroller {
  constructor(container, opts = {}) {
    this.container  = container;
    this.rowHeight  = opts.rowHeight || 40;
    this.overscan   = opts.overscan  || OVERSCAN;

    this.data       = [];       // array de objetos de fila
    this.renderRow  = null;     // función(row, index) → void (llena el trEl)
    this.selected   = new Set();// IDs seleccionados
    this.lastClickedIdx = -1;   // para selección por rango (shift+click)

    this.onSelectionChange = null; // callback(Set<id>)
    this.onRowClick        = null; // callback(row, index)

    // Elementos DOM
    this._spacer  = document.createElement('div');
    this._wrapper = document.createElement('div');
    this._wrapper.style.cssText = 'position:absolute;top:0;left:0;right:0;will-change:transform;';
    this.container.style.cssText += ';position:relative;overflow-y:auto;';
    this.container.appendChild(this._spacer);
    this.container.appendChild(this._wrapper);

    // Pool de nodos DOM reciclados
    this._pool = [];
    this._rendered = new Map(); // dataIndex → trEl

    // Estado de scroll
    this._scrollTop  = 0;
    this._vpHeight   = 0;
    this._startIdx   = 0;
    this._endIdx     = 0;
    this._ticking    = false;

    this._onScroll   = this._handleScroll.bind(this);
    this._onResize   = this._handleResize.bind(this);
    this.container.addEventListener('scroll', this._onScroll, { passive:true });
    window.addEventListener('resize', this._onResize, { passive:true });

    this._updateViewport();
  }

  /* ── Carga de datos ─────────────────────────────────────────*/
  setData(rows, renderFn) {
    this.data      = rows || [];
    this.renderRow = renderFn;
    this.selected.clear();
    this._lastClickedIdx = -1;

    // Actualizar altura total del spacer
    const totalH = this.data.length * this.rowHeight;
    this._spacer.style.height = totalH + 'px';

    // Limpiar nodos renderizados y devolver al pool
    this._rendered.forEach((el) => this._recycle(el));
    this._rendered.clear();

    this._scrollTop = this.container.scrollTop;
    this._render();
  }

  /* Actualiza filas sin resetear scroll/selección */
  updateData(rows) {
    this.data = rows || [];
    this._spacer.style.height = (this.data.length * this.rowHeight) + 'px';
    this._rendered.forEach((el) => this._recycle(el));
    this._rendered.clear();
    this._render();
  }

  /* ── Scroll handler ─────────────────────────────────────────*/
  _handleScroll() {
    this._scrollTop = this.container.scrollTop;
    if (!this._ticking) {
      this._ticking = true;
      requestAnimationFrame(() => {
        this._render();
        this._ticking = false;
      });
    }
  }

  _handleResize() {
    this._updateViewport();
    this._render();
  }

  _updateViewport() {
    this._vpHeight = this.container.clientHeight || window.innerHeight;
  }

  /* ── Renderizado virtual ────────────────────────────────────*/
  _render() {
    const { rowHeight, overscan, data, _scrollTop, _vpHeight } = this;
    if (!data.length || !this.renderRow) return;

    const startRaw = Math.floor(_scrollTop / rowHeight) - overscan;
    const endRaw   = Math.ceil((_scrollTop + _vpHeight) / rowHeight) + overscan;
    const start    = Math.max(0, startRaw);
    const end      = Math.min(data.length - 1, endRaw);

    // Reciclar filas fuera del rango visible
    this._rendered.forEach((el, idx) => {
      if (idx < start || idx > end) {
        this._recycle(el);
        this._rendered.delete(idx);
      }
    });

    // Posicionar wrapper para el primer elemento visible
    this._wrapper.style.transform = `translateY(${start * rowHeight}px)`;

    // Renderizar filas faltantes en el rango
    // Usamos un fragmento para inserción eficiente
    const frag = document.createDocumentFragment();
    let needsAppend = false;

    for (let i = start; i <= end; i++) {
      if (this._rendered.has(i)) continue;
      const el = this._getFromPool(i);
      this.renderRow(data[i], i, el, this.selected.has(data[i].id));
      el.dataset.idx = i;
      el._dataId = data[i].id;

      // Manejador de click para selección
      el.onclick = (ev) => this._handleRowClick(ev, i);

      frag.appendChild(el);
      this._rendered.set(i, el);
      needsAppend = true;
    }

    if (needsAppend) {
      // Reordenar todos los elementos en el wrapper
      this._wrapper.innerHTML = '';
      const sorted = [...this._rendered.entries()].sort(([a],[b]) => a-b);
      sorted.forEach(([,el]) => this._wrapper.appendChild(el));
    }
  }

  /* ── Pool de nodos DOM ──────────────────────────────────────*/
  _getFromPool(idx) {
    return this._pool.pop() || document.createElement('div');
  }

  _recycle(el) {
    // Limpiar estado pero mantener el nodo para reusar
    if (this._pool.length < 100) {
      el.onclick = null;
      this._pool.push(el);
    }
    // Si el pool está lleno, simplemente eliminar
  }

  /* ── Selección ──────────────────────────────────────────────*/
  _handleRowClick(ev, idx) {
    const row = this.data[idx];
    if (!row) return;
    const id  = row.id;

    if (ev.shiftKey && this._lastClickedIdx >= 0) {
      // Selección por rango
      const from = Math.min(this._lastClickedIdx, idx);
      const to   = Math.max(this._lastClickedIdx, idx);
      for (let i = from; i <= to; i++) {
        if (this.data[i]) this.selected.add(this.data[i].id);
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      // Toggle individual
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else {
      // Click simple: seleccionar solo este
      this.selected.clear();
      this.selected.add(id);
    }

    this._lastClickedIdx = idx;
    this._refreshSelection();

    if (this.onRowClick) this.onRowClick(row, idx);
    if (this.onSelectionChange) this.onSelectionChange(new Set(this.selected));
  }

  _refreshSelection() {
    // Actualizar clases CSS en los nodos actualmente renderizados
    this._rendered.forEach((el, idx) => {
      const row = this.data[idx];
      if (!row) return;
      if (this.selected.has(row.id)) {
        el.classList.add('row-selected');
      } else {
        el.classList.remove('row-selected');
      }
    });
  }

  /* ── API pública ────────────────────────────────────────────*/

  /** Selecciona los primeros N elementos de data */
  selectFirst(n) {
    this.selected.clear();
    const limit = Math.min(n, this.data.length);
    for (let i = 0; i < limit; i++) {
      this.selected.add(this.data[i].id);
    }
    this._refreshSelection();
    if (this.onSelectionChange) this.onSelectionChange(new Set(this.selected));
  }

  selectAll() { this.selectFirst(this.data.length); }

  clearSelection() {
    this.selected.clear();
    this._refreshSelection();
    if (this.onSelectionChange) this.onSelectionChange(new Set());
  }

  getSelectedRows() {
    return this.data.filter(r => this.selected.has(r.id));
  }

  /** Hace scroll a un índice específico */
  scrollToIndex(idx) {
    this.container.scrollTop = idx * this.rowHeight;
  }

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
  }
}
