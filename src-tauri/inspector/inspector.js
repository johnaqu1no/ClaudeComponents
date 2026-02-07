(function() {
  'use strict';

  let inspectorActive = false;
  let overlay = null;
  let label = null;
  let currentTarget = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = '__cc_inspector_overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      border: '2px solid #6366f1',
      borderRadius: '4px',
      backgroundColor: 'rgba(99, 102, 241, 0.08)',
      zIndex: '2147483647',
      display: 'none',
      transition: 'top 0.05s, left 0.05s, width 0.05s, height 0.05s',
    });

    label = document.createElement('div');
    label.id = '__cc_inspector_label';
    Object.assign(label.style, {
      position: 'fixed',
      pointerEvents: 'none',
      background: '#4f46e5',
      color: '#fff',
      fontSize: '11px',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontWeight: '600',
      padding: '2px 8px',
      borderRadius: '3px',
      zIndex: '2147483647',
      display: 'none',
      whiteSpace: 'nowrap',
      lineHeight: '1.4',
    });

    document.body.appendChild(overlay);
    document.body.appendChild(label);
  }

  function getReactFiber(element) {
    const keys = Object.keys(element);
    for (const key of keys) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        return element[key];
      }
    }
    return null;
  }

  function findComponentFiber(fiber) {
    let current = fiber;
    while (current) {
      if (typeof current.type === 'function' || typeof current.type === 'object') {
        const name = getComponentName(current);
        if (name && /^[A-Z]/.test(name)) {
          return current;
        }
      }
      current = current.return;
    }
    return null;
  }

  function getComponentName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === 'string') return null;
    return fiber.type.displayName || fiber.type.name || null;
  }

  function getDebugSource(fiber) {
    if (fiber._debugSource) {
      return {
        fileName: fiber._debugSource.fileName,
        lineNumber: fiber._debugSource.lineNumber,
        columnNumber: fiber._debugSource.columnNumber || null,
      };
    }
    if (fiber._debugOwner) {
      return getDebugSource(fiber._debugOwner);
    }
    return null;
  }

  function getElementContext(element) {
    const tag = element.tagName ? element.tagName.toLowerCase() : null;
    const classes = element.className && typeof element.className === 'string'
      ? element.className.trim() : '';
    const id = element.id || null;
    const text = (element.textContent || '').trim();
    const truncatedText = text.length > 60 ? text.slice(0, 60) + '...' : text;

    // Build a short selector-like description
    let selector = tag || '';
    if (id) selector += '#' + id;
    if (classes) selector += '.' + classes.split(/\s+/).join('.');

    return {
      tag: tag,
      className: classes || null,
      id: id,
      textContent: truncatedText || null,
      selector: selector,
    };
  }

  function getComponentInfo(element) {
    const fiber = getReactFiber(element);
    if (!fiber) return null;

    const componentFiber = findComponentFiber(fiber);
    if (!componentFiber) return null;

    const name = getComponentName(componentFiber);
    if (!name) return null;

    const source = getDebugSource(componentFiber);
    const elementContext = getElementContext(element);

    return {
      componentName: name,
      fileName: source ? source.fileName : null,
      lineNumber: source ? source.lineNumber : null,
      element: elementContext,
    };
  }

  function positionOverlay(element) {
    if (!overlay || !label) return;

    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      display: 'block',
    });

    const info = getComponentInfo(element);
    if (info) {
      let labelText = info.componentName;
      if (info.element && info.element.selector) {
        labelText += ' > ' + info.element.selector;
      }
      label.textContent = labelText;

      const labelTop = rect.top - 24;
      Object.assign(label.style, {
        top: (labelTop < 0 ? rect.bottom + 4 : labelTop) + 'px',
        left: rect.left + 'px',
        display: 'block',
      });
    } else {
      label.style.display = 'none';
    }
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (label) label.style.display = 'none';
    currentTarget = null;
  }

  function onMouseMove(e) {
    if (!inspectorActive) return;

    const target = e.target;
    if (target === overlay || target === label) return;
    if (target.id === '__cc_inspector_overlay' || target.id === '__cc_inspector_label') return;

    currentTarget = target;
    positionOverlay(target);
  }

  function onClick(e) {
    if (!inspectorActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const target = currentTarget || e.target;
    if (target === overlay || target === label) return;

    const info = getComponentInfo(target);
    if (info) {
      window.parent.postMessage({
        type: 'component-selected',
        payload: info,
      }, '*');
    } else {
      window.parent.postMessage({
        type: 'component-selected',
        payload: {
          componentName: null,
          fileName: null,
          lineNumber: null,
          error: 'No React component found on this element. Make sure you are running in development mode.',
        },
      }, '*');
    }
  }

  function enableInspector() {
    inspectorActive = true;
    if (!overlay) createOverlay();
    document.body.style.cursor = 'crosshair';
  }

  function disableInspector() {
    inspectorActive = false;
    hideOverlay();
    document.body.style.cursor = '';
  }

  // Listen for toggle messages from parent
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'toggle-inspector') {
      if (inspectorActive) {
        disableInspector();
      } else {
        enableInspector();
      }
    } else if (e.data && e.data.type === 'enable-inspector') {
      enableInspector();
    } else if (e.data && e.data.type === 'disable-inspector') {
      disableInspector();
    } else if (e.data && e.data.type === 'get-location') {
      window.parent.postMessage({
        type: 'current-location',
        path: location.pathname + location.search + location.hash,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }, '*');
    } else if (e.data && e.data.type === 'restore-scroll') {
      window.scrollTo(e.data.scrollX || 0, e.data.scrollY || 0);
    }
  });

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);

  // Disable inspector on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && inspectorActive) {
      disableInspector();
      window.parent.postMessage({ type: 'inspector-deactivated' }, '*');
    }
  });
})();
