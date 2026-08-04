/**
 * Filter menu construction from Orders[].Grouping — port of iOS
 * RRResultsController.buildFilterMenus (itself the RRPublish.js algorithm).
 *
 * Every Grouping > 0 order consumes a groupFilter slot; Grouping >= 2
 * produces a user-facing menu; Grouping == 3 additionally offers <Ignore>.
 * Type == 2 group filters default to <Ignore>.
 */

const { str, toInt } = require('./util');
const { i18n } = require('./i18n');

const IGNORE = '<Ignore>';

/**
 * @param {object} listFormat the list response's `list` object
 * @param {Array}  apiGroupFilters the list response's `groupFilters` array
 * @returns {{menus: Array, groupFilter: string[]}}
 */
function buildFilterMenus(listFormat, apiGroupFilters, lang) {
  const orders = Array.isArray(listFormat?.Orders) ? listFormat.Orders : [];
  const gfs = Array.isArray(apiGroupFilters) ? apiGroupFilters : [];
  const menus = [];
  let gfIndex = -1;
  for (const order of orders) {
    const grouping = typeof order?.Grouping === 'number' ? order.Grouping : toInt(order?.Grouping, 0);
    if (grouping <= 0) continue;
    gfIndex += 1;
    if (grouping < 2) continue;
    const gf = gfIndex < gfs.length ? (gfs[gfIndex] || {}) : {};
    const values = (Array.isArray(gf.Values) ? gf.Values : []).map((v) => i18n(str(v), lang));
    const type = typeof gf.Type === 'number' ? gf.Type : toInt(gf.Type, 0);
    let selected = '';
    if (type === 2) selected = IGNORE;
    else if (typeof gf.Value === 'string' && values.includes(i18n(gf.Value, lang))) selected = gf.Value;
    menus.push({
      slot: gfIndex,
      label: i18n(str(order?.GroupFilterLabel), lang),
      showAll: grouping === 2 || grouping === 3,
      showIgnore: grouping === 3,
      options: values,
      selected,
    });
  }
  const groupFilter = new Array(gfIndex + 1).fill('');
  for (const m of menus) groupFilter[m.slot] = m.selected;
  return { menus, groupFilter };
}

module.exports = { buildFilterMenus, IGNORE };
