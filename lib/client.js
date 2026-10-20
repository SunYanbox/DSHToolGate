/**
 * client.js — browser half of dsh-tool-gate (pre-bundled, no build step).
 *
 * Contributions:
 *   - `conversation.input.dock` : the session-start picker dialog;
 *   - `conversation.session.header.utilities` : a small button that reopens it.
 *
 * All data comes from the loopback JSON API mounted by the host half
 * (`/tool-gate/api/...`).  State is kept per session id in a tiny external
 * store consumed through `useSyncExternalStore`, so both contributions stay in
 * sync without a build-time dependency on the framework's store package.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-gate',
  factory: function (require) {
    var module = { exports: {} }
    ;(function (module, exports, require) {
      var React = require('react')
      var h = React.createElement
      var useSyncExternalStore = React.useSyncExternalStore
      var useEffect = React.useEffect

      var API_BASE = '/tool-gate/api'

      function api(pathname, body) {
        return fetch(API_BASE + pathname, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (res) {
          return res.json().then(function (json) {
            if (!json || json.ok !== true) {
              var message =
                json && json.error && json.error.message ? json.error.message : 'HTTP ' + res.status
              var failure = new Error(message)
              if (json && json.error) {
                failure.code = json.error.code
                failure.detail = json.error.detail
              }
              throw failure
            }
            return json.value
          })
        })
      }

      /* ---------------------------------------------------------------- store */

      var stores = new Map()

      function createStore(sessionId) {
        var snapshot = {
          phase: 'idle',
          groups: [],
          choice: { configured: false, disabled: [] },
          askOnSessionStart: true,
          open: false,
          autoPrompted: false,
          draft: [],
          dirty: false,
          expandOfficial: false,
          started: false,
          pendingDiff: null,
          hovered: null,
          saving: false,
          error: null,
        }
        var subscribers = new Set()

        function set(patch) {
          snapshot = Object.assign({}, snapshot, patch)
          subscribers.forEach(function (fn) {
            fn()
          })
        }

        function load() {
          if (!sessionId) {
            set({ phase: 'error', error: 'session is not ready yet' })
            return Promise.resolve()
          }
          set({ phase: 'loading', error: null })
          return api('/state', { sessionId: sessionId }).then(
            function (value) {
              // Keep unsaved toggles: a slow /state response must not undo a click
              // the user made while the dialog was still loading.
              var keepDraft = snapshot.dirty === true
              set({
                phase: 'ready',
                groups: value.groups || [],
                choice: value.choice || { configured: false, disabled: [] },
                askOnSessionStart: value.askOnSessionStart !== false,
                started: value.started === true,
                draft: keepDraft
                  ? snapshot.draft
                  : (value.choice && value.choice.disabled) || [],
              })
            },
            function (error) {
              set({ phase: 'error', error: String(error && error.message ? error.message : error) })
            },
          )
        }

        var store = {
          sessionId: sessionId,
          get: function () {
            return snapshot
          },
          subscribe: function (fn) {
            subscribers.add(fn)
            return function () {
              subscribers.delete(fn)
            }
          },
          set: set,
          load: load,
          // Same as `load`, but keeps the open/draft state intact and adopts the
          // server's draft only when the user has no unsaved toggles.
          refresh: function () {
            if (snapshot.phase !== 'ready' || snapshot.saving) return
            var before = JSON.stringify(snapshot.groups)
            api('/state', { sessionId: sessionId }).then(
              function (value) {
                if (JSON.stringify(value.groups || []) === before) return
                var groups = value.groups || []
                var known = groups.map(function (group) {
                  return group.name
                })
                set({
                  groups: groups,
                  choice: value.choice || snapshot.choice,
                  askOnSessionStart: value.askOnSessionStart !== false,
                  draft: snapshot.draft.filter(function (name) {
                    return known.indexOf(name) >= 0
                  }),
                })
              },
              function () {
                /* transient failure: retry on the next tick */
              },
            )
          },
          open: function () {
            set({ open: true, hovered: null })
            load()
          },
          close: function () {
            set({ open: false })
          },
          toggle: function (name) {
            var draft = snapshot.draft
            var next = draft.indexOf(name) >= 0
              ? draft.filter(function (n) {
                  return n !== name
                })
              : draft.concat([name])
            set({ draft: next, dirty: true, error: null })
          },
          enableAll: function () {
            set({ draft: [], dirty: true })
          },
          disableAll: function () {
            set({
              draft: snapshot.groups.map(function (group) {
                return group.name
              }),
              dirty: true,
            })
          },
          save: function (confirm) {
            set({ saving: true, error: null })
            var body = { sessionId: sessionId, disabled: snapshot.draft }
            if (confirm === true) body.confirm = true
            return api('/set', body).then(
              function (value) {
                set({
                  saving: false,
                  open: false,
                  pendingDiff: null,
                  dirty: false,
                  choice: value.choice,
                  draft: value.choice.disabled,
                  started: value.started === true,
                  groups: value.groups || snapshot.groups,
                })
              },
              function (error) {
                var code = error && error.code
                if (code === 'needs-confirmation' && error.detail) {
                  set({ saving: false, pendingDiff: error.detail, error: null })
                  return
                }
                set({
                  saving: false,
                  error: String(error && error.message ? error.message : error),
                })
              },
            )
          },
        }
        return store
      }

      function useStore(sessionId) {
        var store = stores.get(sessionId)
        if (!store) {
          store = createStore(sessionId)
          stores.set(sessionId, store)
        }
        var snapshot = useSyncExternalStore(store.subscribe, store.get)
        return [store, snapshot]
      }

      /* ---------------------------------------------------------------- styles */

      var colors = {
        text: 'var(--dsw-alias-text-primary, #1f2328)',
        muted: 'var(--dsw-alias-text-secondary, #6b7280)',
        border: 'var(--dsw-alias-border-subtle, rgba(0,0,0,0.12))',
        card: 'var(--dsw-alias-bg-elevated, #ffffff)',
        accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        accentSoft: 'var(--dsw-alias-brand-primary-soft, rgba(77,107,254,0.12))',
        danger: 'var(--dsw-alias-text-danger, #d92d20)',
        shadow: '0 24px 64px rgba(15, 23, 42, 0.24)',
      }

      var chipBase = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 10px',
        borderRadius: '999px',
        border: '1px solid ' + colors.border,
        background: 'transparent',
        color: colors.muted,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
      }

      function chipStyle(enabled, hovered) {
        var style = Object.assign({}, chipBase)
        if (enabled) {
          style.background = colors.accentSoft
          style.borderColor = colors.accent
          style.color = colors.text
        }
        if (hovered) style.boxShadow = '0 0 0 2px ' + colors.accentSoft
        return style
      }

      function toolTitle(group) {
        return group.tools.length === 0
          ? '不注册任何工具'
          : group.tools
              .map(function (tool) {
                return tool.name
              })
              .join('\n')
      }

      /* ------------------------------------------------------------- dialog UI */

      function GateDialog(props) {
        var sessionId = props.sessionId
        var pair = useStore(sessionId)
        var store = pair[0]
        var snapshot = pair[1]

        useEffect(
          function () {
            if (snapshot.phase === 'idle' || (snapshot.phase === 'error' && sessionId)) store.load()
          },
          [sessionId],
        )


        useEffect(
          function () {
            if (
              snapshot.phase === 'ready' &&
              snapshot.askOnSessionStart &&
              !snapshot.choice.configured &&
              !snapshot.autoPrompted
            ) {
              store.set({ open: true, autoPrompted: true })
            }
          },
          [snapshot.phase, snapshot.choice.configured, snapshot.askOnSessionStart, snapshot.autoPrompted],
        )

        // The session's agent materialises on the first message, which is when
        // preset-provided (official built-in) tools show up in `groups`. While
        // the dialog is open, poll so those chips appear without reopening it.
        useEffect(
          function () {
            if (!snapshot.open || snapshot.phase !== 'ready') return undefined
            var timer = setInterval(function () {
              store.refresh()
            }, 4000)
            return function () {
              clearInterval(timer)
            }
          },
          [snapshot.open, snapshot.phase],
        )

        if (!snapshot.open) return null

        var groups = snapshot.groups
        var draft = snapshot.draft
        var enabledCount = groups.length - draft.filter(function (name) {
          return groups.some(function (group) {
            return group.name === name
          })
        }).length
        var hovered = null
        for (var i = 0; i < groups.length; i += 1) {
          if (groups[i].name === snapshot.hovered) hovered = groups[i]
        }

        var chips = groups.map(function (group) {
          var enabled = draft.indexOf(group.name) < 0
          var style = chipStyle(enabled, snapshot.hovered === group.name)
          if (group.potential) style.borderStyle = 'dashed'
          return h(
            'button',
            {
              key: group.name,
              type: 'button',
              title: toolTitle(group) + (group.potential ? '\n（会话开始后注册）' : ''),
              onClick: function () {
                store.toggle(group.name)
              },
              onMouseEnter: function () {
                store.set({ hovered: group.name })
              },
              onFocus: function () {
                store.set({ hovered: group.name })
              },
              style: style,
            },
            h('span', { 'aria-hidden': true }, enabled ? '✓' : '✕'),
            h('span', null, group.name),
            h('span', { style: { opacity: 0.7 } }, ' · ' + group.tools.length + ' 个工具'),
            group.potential ? h('span', { style: { opacity: 0.55 } }, ' · 待会话') : null,
          )
        })

        // Official DeepSeek packages ship a long roster of tool plugins; keep
        // them folded so third-party plugins stay readable at a glance.
        var officialGroups = groups.filter(function (group) {
          return group.official === true
        })
        var otherGroups = groups.filter(function (group) {
          return group.official !== true
        })
        var chipByName = {}
        groups.forEach(function (group, index) {
          chipByName[group.name] = chips[index]
        })
        var otherChips = otherGroups.map(function (group) {
          return chipByName[group.name]
        })
        var officialChips = officialGroups.map(function (group) {
          return chipByName[group.name]
        })
        var officialEnabled = officialGroups.filter(function (group) {
          return draft.indexOf(group.name) < 0
        }).length
        var officialHeader =
          officialGroups.length === 0
            ? null
            : h(
                'button',
                {
                  key: '__official_header',
                  type: 'button',
                  'aria-expanded': snapshot.expandOfficial === true,
                  title: 'DeepSeek 官方内置插件',
                  onClick: function () {
                    store.set({ expandOfficial: !snapshot.expandOfficial })
                  },
                  style: Object.assign({}, chipBase, {
                    borderStyle: 'dashed',
                    color: colors.text,
                    background: 'transparent',
                  }),
                },
                h('span', { 'aria-hidden': true }, snapshot.expandOfficial ? '▾' : '▸'),
                h('span', null, '官方内置插件'),
                h(
                  'span',
                  { style: { opacity: 0.7 } },
                  ' · ' + officialGroups.length + ' 个 · 已启用 ' + officialEnabled,
                ),
              )
        var chipGroups = snapshot.expandOfficial
          ? otherChips.concat([officialHeader], officialChips)
          : otherChips.concat([officialHeader])
        if (otherGroups.length === 0 && officialGroups.length > 0) chipGroups = [officialHeader].concat(chipGroups)

        // The preview keeps a FIXED height: hovering a short plugin list or a
        // long one must not resize the dialog (it used to jump on every hover).
        var previewHeader = hovered
          ? h('div', { style: { color: colors.text, marginBottom: '2px' } }, hovered.name + ' 将注册：')
          : h('div', { style: { color: colors.muted } }, '把鼠标移到插件标签上，这里会列出它将注册的工具。')
        var previewBody = hovered
          ? h(
              'div',
              null,
              hovered.tools.length === 0
                ? '（无）'
                : hovered.tools
                    .map(function (tool) {
                      return tool.name
                    })
                    .join('、'),
            )
          : null
        var toolList = h(
          'div',
          {
            style: {
              marginTop: '10px',
              padding: '8px 10px',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-sunken, rgba(0,0,0,0.04))',
              fontSize: '12px',
              lineHeight: '18px',
              color: colors.muted,
              height: '132px',
              boxSizing: 'border-box',
              overflowY: 'auto',
              overflowX: 'hidden',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
          },
          previewHeader,
          previewBody,
        )

        return h(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 2147483000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              background: 'rgba(15, 23, 42, 0.42)',
              backdropFilter: 'blur(2px)',
            },
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '本会话启用的插件工具',
          },
          h(
            'div',
            {
              style: {
                width: 'min(640px, 100%)',
                maxHeight: 'min(560px, calc(100vh - 48px))',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '16px',
                border: '1px solid ' + colors.border,
                background: colors.card,
                color: colors.text,
                boxShadow: colors.shadow,
                padding: '20px 22px 18px',
                fontFamily: 'inherit',
              },
            },
            h('div', { style: { fontSize: '16px', fontWeight: 600 } }, '本会话启用哪些插件的工具？'),
            h(
              'div',
              { style: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: colors.muted } },
              '点击标签切换：亮色 = 本会话启用，灰色 = 本会话禁用。鼠标悬停可查看该插件会注册哪些工具；' +
                '被禁用插件的工具不会注入本会话上下文，也不允许执行。应用后会同时记为默认，之后的会话不再自动弹出。',
            ),
            h(
              'div',
              { style: { marginTop: '2px', fontSize: '12px', lineHeight: '18px', color: colors.muted } },
              '提示：标有「待会话」的是预设/官方内置工具，会在会话按当前预设加载时生效；应用后会同时记为默认，已发过消息的会话再次修改会先弹确认。',
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
              h(
                'button',
                { type: 'button', style: Object.assign({}, chipBase, { padding: '4px 10px' }), onClick: store.enableAll },
                '全部启用',
              ),
              h(
                'button',
                { type: 'button', style: Object.assign({}, chipBase, { padding: '4px 10px' }), onClick: store.disableAll },
                '全部禁用',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: Object.assign({}, chipBase, { padding: '4px 10px' }),
                  onClick: function () {
                    store.set({ dirty: false })
                    store.load()
                  },
                },
                '刷新列表',
              ),
            ),
            h(
              'div',
              {
                style: {
                  marginTop: '12px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  overflow: 'auto',
                  maxHeight: '260px',
                  paddingRight: '4px',
                },
              },
              groups.length === 0
                ? h('div', { style: { fontSize: '12px', color: colors.muted } }, '尚未发现任何会注册工具的插件。')
                : chipGroups,
            ),
            toolList,
            snapshot.pendingDiff
              ? h(
                  'div',
                  {
                    role: 'alert',
                    style: {
                      marginTop: '10px',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      border: '1px solid rgba(217, 119, 6, 0.42)',
                      background: 'rgba(245, 158, 11, 0.12)',
                      color: 'var(--dsw-alias-text-primary, #1f2328)',
                      fontSize: '12px',
                      lineHeight: '18px',
                    },
                  },
                  h(
                    'div',
                    { style: { fontWeight: 600, marginBottom: '4px' } },
                    '本会话已经发过消息，修改会立即影响后续对话',
                  ),
                  snapshot.pendingDiff.added && snapshot.pendingDiff.added.length > 0
                    ? h('div', null, '将禁用：' + snapshot.pendingDiff.added.join('、'))
                    : null,
                  snapshot.pendingDiff.removed && snapshot.pendingDiff.removed.length > 0
                    ? h('div', null, '将重新启用：' + snapshot.pendingDiff.removed.join('、'))
                    : null,
                )
              : null,
            snapshot.error
              ? h(
                  'div',
                  { style: { marginTop: '10px', fontSize: '12px', color: colors.danger } },
                  '出错：' + snapshot.error,
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', gap: '10px' } },
              h(
                'div',
                { style: { fontSize: '12px', color: colors.muted } },
                '已启用 ' + enabledCount + ' / ' + groups.length + ' 个含工具的插件',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                snapshot.pendingDiff
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, chipBase, { padding: '6px 14px', borderRadius: '8px' }),
                        onClick: function () {
                          store.set({ pendingDiff: null })
                        },
                      },
                      '取消修改',
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        style: Object.assign({}, chipBase, { padding: '6px 14px', borderRadius: '8px' }),
                        onClick: store.close,
                      },
                      snapshot.choice.configured ? '取消' : '稍后再说',
                    ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: snapshot.saving,
                    style: Object.assign({}, chipBase, {
                      padding: '6px 16px',
                      borderRadius: '8px',
                      // A solid accent that stays legible on light and dark
                      // themes alike: the alias variable can resolve to a very
                      // light tint (white text on it is unreadable).
                      background: snapshot.pendingDiff
                        ? 'linear-gradient(180deg, #f59e0b 0%, #d97706 100%)'
                        : 'linear-gradient(180deg, #5b78ff 0%, #3f5ef5 100%)',
                      borderColor: snapshot.pendingDiff ? '#b45309' : '#3550e0',
                      color: '#ffffff',
                      fontWeight: 600,
                      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.24)',
                      opacity: snapshot.saving ? 0.6 : 1,
                    }),
                    onClick: function () {
                      store.save(snapshot.pendingDiff ? true : undefined)
                    },
                  },
                  snapshot.saving ? '保存中…' : snapshot.pendingDiff ? '仍然应用' : '应用',
                ),
              ),
            ),
          ),
        )
      }

      /* ---------------------------------------------------------- header button */

      function OpenButton(props) {
        var sessionId = props.sessionId
        var pair = useStore(sessionId)
        var store = pair[0]
        var snapshot = pair[1]

        useEffect(
          function () {
            if (snapshot.phase === 'idle' || (snapshot.phase === 'error' && sessionId)) store.load()
          },
          [sessionId],
        )

        var disabledCount = snapshot.groups.filter(function (group) {
          return snapshot.draft.indexOf(group.name) >= 0
        }).length

        return h(
          'button',
          {
            type: 'button',
            title: '选择本会话启用的插件工具（dsh-tool-gate）',
            onClick: store.open,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '26px',
              padding: '0 10px',
              borderRadius: '8px',
              border: '1px solid rgba(77, 107, 254, 0.45)',
              background: 'rgba(77, 107, 254, 0.16)',
              color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
              opacity: 1,
              font: 'inherit',
              fontSize: '12px',
              fontWeight: 600,
              lineHeight: '18px',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          '工具门控',
          disabledCount > 0 ? h('span', { style: { color: colors.danger } }, '·' + disabledCount + ' 关') : null,
        )
      }

      /* ------------------------------------------------------------- entry */

      module.exports = {
        name: 'tool-gate',
        inject: ['slots'],
        apply: function (ctx) {
          ctx.effect(function () {
            return ctx.slots.inject('conversation.input.dock', function* () {
              yield ctx.slots.register(
                { name: 'conversation.input.dock', id: 'tool-gate-dialog', order: 50 },
                GateDialog,
              )
            })
          }, 'tool-gate: session dialog')

          ctx.effect(function () {
            return ctx.slots.inject('conversation.input.left', function* () {
              yield ctx.slots.register(
                { name: 'conversation.input.left', id: 'tool-gate-open', order: 60 },
                OpenButton,
              )
            })
          }, 'tool-gate: composer button')
        },
      }
    })(module, module.exports, require)
    return module.exports
  },
})
