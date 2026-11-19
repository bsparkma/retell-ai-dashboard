'use strict';

/**
 * TESTS ONLY: list every (method, path) an Express 4 router answers, so a test
 * can hit each one. Express 4 keeps a mounted router's path only as a RegExp
 * (layer.regexp), so the mount prefix is recovered from it; a `:param` in a
 * mount or a route becomes the placeholder `p` ('x' segments never collide with
 * a literal route because every route is listed with its own literal path).
 *
 * Used by test/officeGateWiring.test.js (MT-2b3).
 */

const PARAM_VALUE = '00000000-0000-4000-8000-000000000000';

/**
 * Recover a mount prefix from an Express 4 layer regexp, e.g.
 *   /^\/cases\/?(?=\/|$)/i            -> /cases
 *   /^\/cases\/(?:([^\/]+?))\/?(?=\/|$)/i -> /cases/<param>
 * @param {RegExp} re
 * @returns {string}
 */
function mountPath(re) {
  if (re.fast_slash) return '';
  let s = re.source;
  s = s.replace(/^\^/, '');
  s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, ''); // trailing /?(?=/|$)
  s = s.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, PARAM_VALUE); // a :param
  s = s.replace(/\\\//g, '/');
  s = s.replace(/\\-/g, '-');
  s = s.replace(/\\\./g, '.');
  if (/[\\()[\]^$*+?|{}]/.test(s)) throw new Error(`[routeWalk] cannot read mount path from ${re}`);
  return s === '/' ? '' : s;
}

/**
 * @param {string} path an Express route path ('/:id/send')
 * @returns {string}
 */
function fillParams(path) {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\??/g, PARAM_VALUE);
}

/**
 * @param {{ stack: Array<any> }} router
 * @param {string} [prefix]
 * @returns {Array<{ method: string, path: string, routePath: string }>}
 */
function walkRoutes(router, prefix = '') {
  /** @type {Array<{ method: string, path: string, routePath: string }>} */
  const out = [];
  for (const layer of router.stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') throw new Error(`[routeWalk] non-string route path under ${prefix}`);
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.push({ method: method.toUpperCase(), path: prefix + fillParams(p), routePath: prefix + p });
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      out.push(...walkRoutes(layer.handle, prefix + mountPath(layer.regexp)));
    }
  }
  return out;
}

module.exports = { walkRoutes, mountPath, PARAM_VALUE };
