/**
 * fake-model.cjs — minimal OpenAI-compatible endpoint on 127.0.0.1:8898.
 * Logs every request's tool list, then replies with either a working_directory
 * tool call (first turn) or plain "OK" (after a tool result).
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.env.FAKE_MODEL_PORT || 8898)
const LOG = path.join(__dirname, 'model-requests.log')

function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => {
    body += chunk
  })
  req.on('end', () => {
    let json = {}
    try {
      json = JSON.parse(body)
    } catch {
      json = {}
    }
    const tools = (json.tools || []).map(tool => (tool.function ? tool.function.name : tool.name))
    const messages = json.messages || []
    const last = messages[messages.length - 1] || {}
    const hasToolResult = messages.some(message => message.role === 'tool')
    log({
      at: new Date().toISOString(),
      url: req.url,
      model: json.model,
      stream: !!json.stream,
      toolCount: tools.length,
      tools,
      lastRole: last.role,
      lastText: typeof last.content === 'string' ? last.content.slice(0, 120) : last.content,
    })

    const toolCall = {
      id: 'call_fake_1',
      type: 'function',
      function: { name: 'working_directory', arguments: '{}' },
    }
    const wantTool = !hasToolResult

    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish) => {
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl-fake',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: json.model || 'fake-1',
              choices: [{ index: 0, delta, finish_reason: finish ?? null }],
            }) +
            '\n\n',
        )
      }
      chunk({ role: 'assistant', content: wantTool ? '' : 'OK' })
      if (wantTool) chunk({ tool_calls: [{ index: 0, ...toolCall }] })
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const message = wantTool
      ? { role: 'assistant', content: null, tool_calls: [toolCall] }
      : { role: 'assistant', content: 'OK' }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: json.model || 'fake-1',
        choices: [{ index: 0, message, finish_reason: wantTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('fake model listening on ' + PORT)
})
