// Fixture bundle: registers one tool, used to test attribution order.
export const name = 'gate-fixture'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'fixture_probe',
    description: 'Fixture tool registered by the gate-fixture bundle.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute() {
      return 'fixture says hi'
    },
  })
}

