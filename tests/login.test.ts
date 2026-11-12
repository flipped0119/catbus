import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { getCurrent, listAccounts, newCredential, readCredential, setCurrent, writeCredential } from '../src/core/auth-store.js'
import { accountNameFor, finishLogin, smsLogin, smsState } from '../src/core/login.js'
import type { HandlerContext } from '../src/core/registry.js'
import type { AccountUser } from '../src/core/schemas.js'
import { findPlatform } from '../src/platforms/index.js'
import { cli, useTempHome } from './helpers.js'

useTempHome()

const alice: AccountUser = { id: 'u-alice', name: 'Alice', url: null, avatar: 'https://example.com/alice.png' }
// bob 没有头像：替换 alice 时不能继承她的头像
const bob: AccountUser = { id: 'u-bob', name: 'Bob', url: null, avatar: null }

/** finishLogin 只用到平台、端、账号、选项和 logger。 */
function loginCtx(account: string | null, options: Record<string, unknown> = {}) {
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`), debug: () => {} }
  const ctx = { platform: findPlatform('xhs')!, endpoint: 'web', account, options, log } as unknown as HandlerContext
  return { ctx, logs }
}

function fresh(account: string, token: string) {
  const c = newCredential({ platform: 'xhs', endpoint: 'web', account, method: 'cookie' })
  c.scopes.main!.tokens.t = token
  return c
}

async function seed(account: string, user: AccountUser, token: string) {
  const c = fresh(account, token)
  c.user = user
  await writeCredential(c)
}

describe('finishLogin（AGENTS 5.3）', () => {
  it('默认：账号名下原来是另一个用户时，视为先登出再登录，替换旧凭证并在 stderr 提示', async () => {
    await seed('default', alice, 'old')
    await setCurrent('xhs', 'web', 'default')
    const { ctx, logs } = loginCtx('default')
    const account = await finishLogin(ctx, fresh('default', 'new'), bob)
    expect(account).toMatchObject({ account: 'default', current: true, user: bob })
    const saved = await readCredential('xhs', 'web', 'default')
    expect(saved?.user).toEqual(bob)
    expect(saved?.scopes.main!.tokens.t).toBe('new')
    expect(logs).toContain('warn 账号 default 原来登录的是 Alice，已替换为 Bob')
  })

  it('--auto-bind：已保存过的用户刷新原来的账号，不改当前账号', async () => {
    await seed('default', alice, 'a-old')
    await seed('work', bob, 'b-old')
    await setCurrent('xhs', 'web', 'default')
    const { ctx } = loginCtx('default', { autoBind: true })
    const account = await finishLogin(ctx, fresh('default', 'b-new'), bob)
    expect(account).toMatchObject({ account: 'work', current: false, user: bob })
    expect((await readCredential('xhs', 'web', 'work'))?.scopes.main!.tokens.t).toBe('b-new')
    expect((await readCredential('xhs', 'web', 'default'))?.scopes.main!.tokens.t).toBe('a-old')
    expect(await getCurrent('xhs', 'web')).toBe('default')
  })

  it('--auto-bind：新用户、default 空着时存到 default，并设为当前账号', async () => {
    await seed('work', alice, 'a')
    await setCurrent('xhs', 'web', 'work')
    const { ctx } = loginCtx('work', { autoBind: true })
    const account = await finishLogin(ctx, fresh('work', 'b'), bob)
    expect(account).toMatchObject({ account: 'default', current: false })
    expect((await listAccounts('xhs', 'web')).map((a) => a.account)).toEqual(['default', 'work'])

    // 一个账号都没有时，新账号成为当前账号
    const other = loginCtx(null, { autoBind: true })
    other.ctx.platform = findPlatform('bilibili')!
    const c = newCredential({ platform: 'bilibili', endpoint: 'web', account: 'default', method: 'cookie' })
    expect(await finishLogin(other.ctx, c, alice)).toMatchObject({ account: 'default', current: true })
  })

  it('--auto-bind：新用户、default 已被占用时按用户 id 新增账号', async () => {
    await seed('default', alice, 'a')
    await setCurrent('xhs', 'web', 'default')
    const { ctx } = loginCtx('default', { autoBind: true })
    const account = await finishLogin(ctx, fresh('default', 'b'), bob)
    expect(account).toMatchObject({ account: 'u-bob', current: false, user: bob })
    expect((await readCredential('xhs', 'web', 'default'))?.user).toEqual(alice)
  })

  it('accountNameFor：转成合法账号名，冲突或起不出来时加序号', () => {
    expect(accountNameFor({ id: '5F3A_xY', name: null, url: null, avatar: null }, new Set())).toBe('5f3a_xy')
    expect(accountNameFor({ id: '@Elon.Musk', name: null, url: null, avatar: null }, new Set())).toBe('elon-musk')
    expect(accountNameFor({ id: '123', name: null, url: null, avatar: null }, new Set(['123', '123-2']))).toBe('123-3')
    expect(accountNameFor({ id: '中文', name: null, url: null, avatar: null }, new Set())).toBe('account-2')
    expect(accountNameFor({ id: 'guest', name: null, url: null, avatar: null }, new Set())).toBe('guest-2')
    const long = accountNameFor({ id: 'x'.repeat(40), name: null, url: null, avatar: null }, new Set(['x'.repeat(32)]))
    expect(long).toBe('x'.repeat(30) + '-2')
  })
})

describe('smsLogin 的 stdin 秘密选项（T-2975）', () => {
  function stdin(text: string) {
    const stream = Object.assign(Readable.from([text]), { isTTY: false })
    return vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as unknown as typeof process.stdin)
  }

  it('--phone - 从 stdin 读取单行手机号，不把值放进 argv', async () => {
    const secret = ['190', '0000', '0000'].join('')
    const mock = stdin(secret + '\n')
    try {
      const { ctx } = loginCtx('default', { phone: '-' })
      let seen = ''
      const result = await smsLogin(ctx, {
        send: async (phone) => { seen = phone; return { phone } },
        verify: async () => { throw new Error('本用例不应进入 verify') },
      })
      expect(seen).toBe(secret)
      expect(ctx.options.phone).toBe(secret)
      expect(result).toMatchObject({ sent: true })
    } finally {
      mock.mockRestore()
    }
  })

  it('--code - 从 stdin 读取并同步 ctx.options，供平台 verify/select 使用', async () => {
    const secret = ['000', '000'].join('')
    const mock = stdin(secret + '\n')
    try {
      const { ctx } = loginCtx('default', { code: '-' })
      await smsState.save(ctx, { phone: 'stored-offline-value' })
      let seen = ''
      await smsLogin(ctx, {
        send: async () => { throw new Error('本用例不应进入 send') },
        verify: async (_state, code) => {
          seen = code
          expect(ctx.options.code).toBe(secret)
          return { platform: 'xhs' } as any
        },
      })
      expect(seen).toBe(secret)
    } finally {
      mock.mockRestore()
    }
  })

  it('phone/code 不共用一个 stdin，避免把两项拼进日志或参数', async () => {
    const { ctx } = loginCtx('default', { phone: '-', code: '-' })
    await expect(smsLogin(ctx, { send: async () => ({}), verify: async () => ({}) as any })).rejects.toMatchObject({ code: 'USAGE' })
  })
})

describe('auth login --auto-bind 的参数校验', () => {
  it('不能和 -a、--scope 一起用', async () => {
    const a = await cli('xhs', 'auth', 'login', '--auto-bind', '-a', 'work', '--method', 'cookie', '--cookie', 'a=b')
    expect(a.env.error).toMatchObject({ code: 'USAGE', message: '--auto-bind 会自动选择账号，不能和 -a 一起用' })
    const s = await cli('xhs', 'auth', 'login', '--auto-bind', '--scope', 'creator')
    expect(s.env.error.code).toBe('USAGE')
    expect(s.env.error.hint).toBe('catbus xhs auth login -a <账号> --scope creator')
  })
})
