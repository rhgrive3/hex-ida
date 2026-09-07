import { ProductRouter } from './router.js';
import { installProductUI as installBaseProductUI } from './product-base.js';
import { renderProductResultsRoute } from './product-results.js';

export * from './product-base.js';

function renderCanonicalProductRoute(app, router, route, routeContext = {}) {
  const appRoot = document.getElementById('app');
  const routeHost = document.getElementById('ui-route-host');
  if (!appRoot || !routeHost) {
    const error = new Error('product-route-host-unavailable');
    error.code = 'PRODUCT_ROUTE_HOST_UNAVAILABLE';
    throw error;
  }

  appRoot.classList.remove('ui-code-route');
  appRoot.classList.add('ui-screen-route');
  for (const button of appRoot.querySelectorAll('.ui-bottom-nav [data-route-id]')) {
    button.setAttribute('aria-current', button.dataset.routeId === 'results' ? 'page' : 'false');
  }

  routeHost.hidden = false;
  routeHost.replaceChildren();
  const view = renderProductResultsRoute(app, router, route, routeContext);
  routeHost.append(view.root);
  requestAnimationFrame(() => routeHost.focus({ preventScroll: true }));

  const originalGet = view.getState;
  return {
    ...view,
    getState: () => ({ ...(originalGet ? originalGet() : {}), routeScroll: routeHost.scrollTop }),
    restoreState: (state) => {
      view.restoreState?.(state);
      routeHost.scrollTop = Number(state?.routeScroll) || 0;
    },
  };
}

/*
 * Product Results is migrated independently from the rest of the product shell.
 * Patch ProductRouter.start only for the synchronous installation window so the
 * very first deep-link render is canonical too; the router instance keeps the
 * wrapped onRoute callback afterwards, while the prototype is restored before
 * this function returns. Results/Finding never fall back to the legacy renderer.
 */
export function installProductUI(app) {
  const originalStart = ProductRouter.prototype.start;
  ProductRouter.prototype.start = function startWithCanonicalResults(...args) {
    const baseOnRoute = this.onRoute;
    this.onRoute = (route, routeContext = {}) => {
      if (route?.route?.id === 'results' || route?.route?.id === 'finding') {
        return renderCanonicalProductRoute(app, this, route, routeContext);
      }
      return baseOnRoute(route, routeContext);
    };
    return originalStart.apply(this, args);
  };

  try {
    return installBaseProductUI(app);
  } finally {
    ProductRouter.prototype.start = originalStart;
  }
}
