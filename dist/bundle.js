/*
 * School Menu plugin for Home Screens.
 * Plain IIFE, no build step needed: React comes from the host global and the
 * SDK from window.__HS_SDK__. Health-e Pro is reached through pluginFetch.
 */
(function () {
  'use strict';

  var PLUGIN_ID = 'school-menu';
  var API = 'https://menus.healthepro.com/api/organizations';
  var REFRESH_MS = 60 * 1000; // re-check the date every minute (cheap: responses are cached)
  var CACHE_MS = 30 * 60 * 1000; // upstream cache, max allowed is 1 hour

  function sdk() {
    return window.__HS_SDK__;
  }

  // ---------------------------------------------------------------- data layer

  function getJson(url) {
    return sdk()
      .pluginFetch(PLUGIN_ID, { url: url, cacheTtlMs: CACHE_MS })
      .then(function (res) {
        if (!res.ok) throw new Error('Health-e Pro returned ' + res.status);
        return res.json();
      });
  }

  // Responses wrap their payload in { data: ... }. Be tolerant of arrays of
  // arrays and of objects grouped by key (the org list is grouped by state).
  function asList(json) {
    var d = json && json.data !== undefined ? json.data : json;
    if (Array.isArray(d)) {
      return d.reduce(function (acc, x) {
        return acc.concat(Array.isArray(x) ? x : [x]);
      }, []);
    }
    if (d && typeof d === 'object') {
      return Object.keys(d).reduce(function (acc, k) {
        return acc.concat(Array.isArray(d[k]) ? d[k] : []);
      }, []);
    }
    return [];
  }

  function firstString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj && obj[keys[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  // Best effort: the district name is not part of any endpoint I could confirm,
  // so accept a few plausible shapes and fall back to '' (the UI then shows nothing).
  function nameFromOrg(json) {
    var d = json && json.data !== undefined ? json.data : json;
    if (Array.isArray(d)) d = d[0];
    return firstString(d, ['name', 'organization_name', 'title', 'display_name']);
  }

  function nameFromSites(sites) {
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i] || {};
      var n =
        firstString(s, ['organization_name', 'org_name', 'district_name']) ||
        firstString(s.organization, ['name', 'title']) ||
        firstString(s.org, ['name', 'title']);
      if (n) return n;
    }
    return '';
  }

  function getOrgName(org) {
    return getJson(API + '/' + encodeURIComponent(org))
      .then(nameFromOrg)
      .catch(function () {
        return '';
      });
  }

  function listSites(org) {
    return getJson(API + '/' + encodeURIComponent(org) + '/sites/list').then(asList);
  }

  function listMenus(org, site) {
    return getJson(
      API + '/' + encodeURIComponent(org) + '/sites/' + encodeURIComponent(site) + '/menus/'
    ).then(asList);
  }

  function fetchMonth(org, menuId, year, month) {
    return getJson(
      API +
        '/' + encodeURIComponent(org) +
        '/menus/' + encodeURIComponent(menuId) +
        '/year/' + year + '/month/' + month + '/date_overwrites'
    ).then(asList);
  }

  // ------------------------------------------------------------------- parsing

  // One date_overwrites entry -> { day, dayOff, groups: [{ name, items[] }] }
  function parseDay(entry) {
    var setting = entry && entry.setting;
    if (typeof setting === 'string') {
      try {
        setting = JSON.parse(setting);
      } catch (e) {
        setting = {};
      }
    }
    setting = setting || {};

    var off = setting.days_off || {};
    var dayOff = off.status ? off.description || 'No school' : null;

    var rows = (setting.current_display || []).slice().sort(function (a, b) {
      return (a.weight || 0) - (b.weight || 0);
    });

    var groups = [];
    var byName = {};
    var current = null;
    rows.forEach(function (row) {
      if (row.type === 'category') {
        var name = row.name || '';
        if (!byName[name]) {
          byName[name] = { name: name, items: [] };
          groups.push(byName[name]);
        }
        current = byName[name];
      } else if (row.type === 'recipe') {
        if (!current) {
          if (!byName['']) {
            byName[''] = { name: '', items: [] };
            groups.push(byName['']);
          }
          current = byName[''];
        }
        if (current.items.indexOf(row.name) === -1) current.items.push(row.name);
      }
    });

    return {
      day: String(entry.day).slice(0, 10),
      dayOff: dayOff,
      groups: groups.filter(function (g) {
        return g.items.length > 0;
      }),
    };
  }

  function pickDay(entries, iso) {
    for (var i = 0; i < entries.length; i++) {
      if (String(entries[i].day).slice(0, 10) === iso) return entries[i];
    }
    return null;
  }

  // "YYYY-MM-DD" plus n days, done in UTC so DST and device timezone can't skew it.
  function addDays(iso, n) {
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    var pad = function (x) {
      return (x < 10 ? '0' : '') + x;
    };
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  var LOOKAHEAD_DAYS = 14;

  // Decide which day to show. Before `advanceHour` (or when it is 0/off) that is
  // today. After it, the next day that actually has a menu, looking up to two
  // weeks ahead so weekends, holidays and breaks are skipped.
  function resolveDay(entries, iso, minuteOfDay, advanceHour) {
    var advance = Number(advanceHour) || 0;
    var today = pickDay(entries, iso);
    if (advance <= 0 || minuteOfDay < advance * 60) {
      return { iso: iso, isNext: false, isTomorrow: false, day: today ? parseDay(today) : null };
    }
    for (var i = 1; i <= LOOKAHEAD_DAYS; i++) {
      var candidate = addDays(iso, i);
      var entry = pickDay(entries, candidate);
      if (!entry) continue;
      var parsed = parseDay(entry);
      if (!parsed.dayOff && parsed.groups.length > 0) {
        return { iso: candidate, isNext: true, isTomorrow: i === 1, day: parsed };
      }
    }
    return { iso: iso, isNext: false, isTomorrow: false, day: null };
  }

  function wall() {
    try {
      var w = sdk().wallClock();
      if (w && w.isoDate) return { isoDate: w.isoDate, minuteOfDay: w.minuteOfDay || 0 };
    } catch (e) {
      /* fall through */
    }
    var d = new Date();
    var p = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return {
      isoDate: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
      minuteOfDay: d.getHours() * 60 + d.getMinutes(),
    };
  }

  // Base text size in px (everything inside scales from this via em units).
  function fontSizePx(config) {
    var n = Number(config && config.fontSize);
    if (!isFinite(n) || n <= 0) return 16;
    return Math.max(8, Math.min(96, Math.round(n)));
  }

  function parseHidden(text) {
    return String(text || '')
      .split(',')
      .map(function (s) {
        return s.trim().toLowerCase();
      })
      .filter(Boolean);
  }

  function visibleGroups(groups, hideText) {
    var hidden = parseHidden(hideText);
    return groups.filter(function (g) {
      return hidden.indexOf(g.name.trim().toLowerCase()) === -1;
    });
  }

  function prettyDate(iso) {
    try {
      var parts = iso.split('-');
      var d = new Date(+parts[0], +parts[1] - 1, +parts[2], 12);
      return sdk().formatDate(d, 'EEEE, MMMM d');
    } catch (e) {
      return iso;
    }
  }

  // -------------------------------------------------------------------- render

  function dateLine(state) {
    var label = state.isNext ? (state.isTomorrow ? 'Tomorrow' : 'Next school day') : '';
    return (label ? label + ' \u00b7 ' : '') + prettyDate(state.iso);
  }

  // Pure: builds the element tree with whatever `h` it is given (so it can be
  // unit-tested without React).
  function renderBody(h, state, config) {
    var small = { fontSize: '0.8em', opacity: 0.7 };

    if (state.unconfigured) {
      return h('div', { style: { opacity: 0.8 } }, 'Choose a school and menu in this module\u2019s settings.');
    }
    if (!state.monthPublished) {
      return h('div', { style: { opacity: 0.8 } }, 'No menu published for this month yet.');
    }
    if (!state.day || state.day.dayOff || state.day.groups.length === 0) {
      var reason = state.day && state.day.dayOff;
      return h(
        'div',
        null,
        h('div', { style: { fontWeight: 600 } }, config.noSchoolText || 'No school meals today'),
        reason ? h('div', { style: small }, reason) : null
      );
    }

    var groups = visibleGroups(state.day.groups, config.hideCategories);
    return h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '0.6em' } },
      groups.map(function (g, i) {
        return h(
          'div',
          { key: g.name + i },
          g.name
            ? h(
                'div',
                { style: { fontSize: '0.75em', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6 } },
                g.name
              )
            : null,
          g.items.map(function (item, j) {
            return h('div', { key: j, style: { fontWeight: i === 0 ? 600 : 400 } }, item);
          })
        );
      })
    );
  }

  function SchoolMenu(props) {
    var React = window.React;
    var h = React.createElement;
    var config = props.config || {};
    var org = String(config.organizationId || '').trim();
    var menuId = String(config.menuId || '').trim();

    var _s = React.useState({ loading: true });
    var state = _s[0];
    var setState = _s[1];

    React.useEffect(
      function () {
        if (!org || !menuId) {
          setState({ unconfigured: true });
          return undefined;
        }
        var alive = true;
        var advanceHour = config.advanceAfterHour;
        function monthOf(iso) {
          return { y: +iso.slice(0, 4), m: +iso.slice(5, 7) };
        }
        function load() {
          var w = wall();
          var iso = w.isoDate;
          var cur = monthOf(iso);
          var later = monthOf(addDays(iso, LOOKAHEAD_DAYS));
          var wantsNext = Number(advanceHour) > 0 && w.minuteOfDay >= Number(advanceHour) * 60;
          var needsLater = wantsNext && (later.y !== cur.y || later.m !== cur.m);

          var main = fetchMonth(org, menuId, cur.y, cur.m);
          // The following month may not be published yet; that is not an error.
          var extra = needsLater
            ? fetchMonth(org, menuId, later.y, later.m).catch(function () {
                return [];
              })
            : Promise.resolve([]);

          Promise.all([main, extra])
            .then(function (res) {
              if (!alive) return;
              var entries = res[0].concat(res[1]);
              var r = resolveDay(entries, iso, w.minuteOfDay, advanceHour);
              setState({
                iso: r.iso,
                isNext: r.isNext,
                isTomorrow: r.isTomorrow,
                monthPublished: entries.length > 0,
                day: r.day,
              });
            })
            .catch(function (err) {
              if (alive) setState({ error: err instanceof Error ? err.message : String(err) });
            });
        }
        setState({ loading: true });
        load();
        var id = setInterval(load, REFRESH_MS);
        return function () {
          alive = false;
          clearInterval(id);
        };
      },
      [org, menuId, config.advanceAfterHour]
    );

    var ready = !state.loading && !state.error;
    var content = ready
      ? h(
          'div',
          { style: { padding: 16, height: '100%', boxSizing: 'border-box', overflow: 'hidden', fontSize: fontSizePx(config) + 'px' } },
          config.title
            ? h('div', { style: { fontSize: '1.1em', fontWeight: 700 } }, config.title)
            : null,
          state.iso ? h('div', { style: { fontSize: '0.8em', opacity: 0.7, marginBottom: '0.6em' } }, dateLine(state)) : null,
          renderBody(h, state, config)
        )
      : null;

    var S = sdk();
    if (S && S.ModuleLoadingState) {
      return h(S.ModuleLoadingState, { loading: !!state.loading, error: state.error }, content);
    }
    return content || h('div', { style: { padding: 16 } }, state.error || 'Loading\u2026');
  }

  // ------------------------------------------------------------- config panel

  function ConfigSection(props) {
    var React = window.React;
    var h = React.createElement;
    var S = sdk();
    var config = props.config || {};
    var onChange = props.onChange;
    var INPUT = S.INPUT_CLASS;
    var LABEL = 'block text-xs text-neutral-400 mb-1 mt-3';

    var org = String(config.organizationId || '').trim();
    var site = String(config.siteId || '').trim();

    var _d = React.useState(org);
    var orgDraft = _d[0];
    var setOrgDraft = _d[1];
    var _sites = React.useState([]);
    var sites = _sites[0];
    var setSites = _sites[1];
    var _menus = React.useState([]);
    var menus = _menus[0];
    var setMenus = _menus[1];
    var _on = React.useState('');
    var orgName = _on[0];
    var setOrgName = _on[1];
    var _err = React.useState('');
    var err = _err[0];
    var setErr = _err[1];

    React.useEffect(
      function () {
        if (!org) {
          setSites([]);
          return undefined;
        }
        var alive = true;
        setErr('');
        listSites(org)
          .then(function (l) {
            if (alive) setSites(l);
          })
          .catch(function (e) {
            if (alive) {
              setSites([]);
              setErr('Could not load schools: ' + e.message);
            }
          });
        return function () {
          alive = false;
        };
      },
      [org]
    );

    // District name: from the org endpoint if it has one, else from the site list.
    React.useEffect(
      function () {
        if (!org) {
          setOrgName('');
          return undefined;
        }
        var alive = true;
        getOrgName(org).then(function (n) {
          if (alive) setOrgName(n || nameFromSites(sites));
        });
        return function () {
          alive = false;
        };
      },
      [org, sites]
    );

    React.useEffect(
      function () {
        if (!org || !site) {
          setMenus([]);
          return undefined;
        }
        var alive = true;
        listMenus(org, site)
          .then(function (l) {
            if (alive) setMenus(l);
          })
          .catch(function (e) {
            if (alive) {
              setMenus([]);
              setErr('Could not load menus: ' + e.message);
            }
          });
        return function () {
          alive = false;
        };
      },
      [org, site]
    );

    function commitOrg() {
      var v = orgDraft.trim();
      if (v !== org) onChange({ organizationId: v, siteId: '', menuId: '' });
    }

    function label(item) {
      return item.name || item.title || item.site_name || String(item.id);
    }

    var body = h(
      'div',
      null,
      h('label', { className: LABEL }, 'District ID'),
      h('input', {
        className: INPUT,
        value: orgDraft,
        placeholder: '1031',
        onChange: function (e) {
          setOrgDraft(e.target.value);
        },
        onBlur: commitOrg,
        onKeyDown: function (e) {
          if (e.key === 'Enter') commitOrg();
        },
      }),
      orgName ? h('div', { className: 'text-xs text-emerald-400 mt-1' }, orgName) : null,
      h('div', { className: 'text-xs text-neutral-500 mt-1' }, 'The number in menus.healthepro.com/organizations/<id>'),

      h('label', { className: LABEL }, 'School'),
      h(
        'select',
        {
          className: INPUT,
          value: site,
          onChange: function (e) {
            onChange({ siteId: e.target.value, menuId: '' });
          },
        },
        h('option', { value: '' }, sites.length ? 'Select a school\u2026' : 'No schools loaded'),
        sites.map(function (s) {
          return h('option', { key: s.id, value: String(s.id) }, label(s));
        })
      ),

      h('label', { className: LABEL }, 'Menu'),
      h(
        'select',
        {
          className: INPUT,
          value: String(config.menuId || ''),
          disabled: !site,
          onChange: function (e) {
            onChange({ menuId: e.target.value });
          },
        },
        h('option', { value: '' }, menus.length ? 'Select a menu\u2026' : 'No menus loaded'),
        menus.map(function (m) {
          return h('option', { key: m.id, value: String(m.id) }, label(m));
        })
      ),

      err ? h('div', { className: 'text-xs text-red-400 mt-2' }, err) : null,

      h('label', { className: LABEL }, 'Title'),
      h('input', {
        className: INPUT,
        value: config.title || '',
        onChange: function (e) {
          onChange({ title: e.target.value });
        },
      }),

      h('label', { className: LABEL }, 'Text size (' + fontSizePx(config) + ' px)'),
      h('input', {
        className: INPUT,
        type: 'range',
        min: 10,
        max: 64,
        step: 1,
        value: fontSizePx(config),
        onChange: function (e) {
          onChange({ fontSize: parseInt(e.target.value, 10) });
        },
      }),

      h('label', { className: LABEL }, 'Hide categories (comma separated)'),
      h('input', {
        className: INPUT,
        value: config.hideCategories || '',
        placeholder: 'Milk, Condiments',
        onChange: function (e) {
          onChange({ hideCategories: e.target.value });
        },
      }),

      h('label', { className: LABEL }, 'Show the next school day after this hour (0 = off)'),
      h('input', {
        className: INPUT,
        type: 'number',
        min: 0,
        max: 23,
        step: 1,
        value: config.advanceAfterHour === undefined ? 0 : config.advanceAfterHour,
        onChange: function (e) {
          var n = parseInt(e.target.value, 10);
          onChange({ advanceAfterHour: isNaN(n) ? 0 : Math.max(0, Math.min(23, n)) });
        },
      }),
      h('div', { className: 'text-xs text-neutral-500 mt-1' }, 'e.g. 14 switches to tomorrow\u2019s menu at 2 PM, skipping weekends and holidays'),

      h('label', { className: LABEL }, 'Text when there is no meal'),
      h('input', {
        className: INPUT,
        value: config.noSchoolText || '',
        onChange: function (e) {
          onChange({ noSchoolText: e.target.value });
        },
      })
    );

    // AccordionSection only exists in the editor; ConfigSection only renders there.
    return S.AccordionSection ? h(S.AccordionSection, { title: 'School Menu' }, body) : body;
  }

  window.__HS_PLUGIN__ = {
    default: SchoolMenu,
    ConfigSection: ConfigSection,
    // Exposed for tests; the host ignores unknown exports.
    _internals: { parseDay: parseDay, pickDay: pickDay, visibleGroups: visibleGroups, renderBody: renderBody, asList: asList, nameFromOrg: nameFromOrg, nameFromSites: nameFromSites, getOrgName: getOrgName, fontSizePx: fontSizePx, resolveDay: resolveDay, addDays: addDays, dateLine: dateLine, fetchMonth: fetchMonth, listMenus: listMenus, listSites: listSites },
  };
})();
