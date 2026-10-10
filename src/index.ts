import { Context, Schema, Logger, h } from 'koishi'
import axios from 'axios'
import axiosRetry from 'axios-retry'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface Config {
  groupId: number
  interval: number
  activityTestMode: boolean
}

export const Config: Schema<Config> = Schema.object({
  groupId: Schema.number().description('目标群号（UIN）'),
  interval: Schema.number().default(10).description('检查新活动的间隔时间（分钟）'),
  activityTestMode: Schema.boolean().default(false).description('活动测试开关：开启时选择时间最接近当前时间的活动；关闭时只选择尚未开始的最近活动'),
})

export const inject = ['puppeteer']

const STORAGE_PATH = join(__dirname, 'last-events.json')

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('airwaysn-event')
  let lastTitles = new Set<string>()

  // 请求失败时自动重试
  axiosRetry(axios, {
    retries: 3,
    retryDelay: (count) => count * 1000,
    retryCondition: (err) => (err.response?.status ?? 0) >= 500,
  })

  // 加载本地缓存
  function loadCache() {
    if (existsSync(STORAGE_PATH)) {
      try {
        const raw = readFileSync(STORAGE_PATH, 'utf8')
        lastTitles = new Set(JSON.parse(raw))
        logger.info(`已加载 ${lastTitles.size} 条活动缓存`)
      } catch {
        logger.warn('读取活动缓存失败，将重新初始化')
      }
    }
  }

  // 保存本地缓存
  function saveCache() {
    try {
      writeFileSync(STORAGE_PATH, JSON.stringify([...lastTitles]), 'utf8')
    } catch (e) {
      logger.error('保存缓存失败：', e)
    }
  }

  // 调用 OneBot 接口的统一入口（NapCat / LLOneBot / SnowLuma 等 OneBot v11 实现均适用）：
  // 优先使用 adapter-onebot 的 internal._get(action, params)，action 会原样转发给协议端；
  // 旧版适配器退回 _request 并手动检查 retcode 信封（retcode === 0 才算成功）。
  async function callOneBotAction(bot: any, action: string, params: Record<string, any>): Promise<any> {
    const internal: any = bot?.internal
    if (typeof internal?._get === 'function') return await internal._get(action, params)
    if (typeof internal?._request === 'function') {
      const response = await internal._request(action, params)
      if (response && typeof response === 'object' && 'retcode' in response) {
        if (response.retcode === 0) return response.data
        throw new Error(`OneBot ${action} failed: retcode=${response.retcode} ${response.message || response.wording || ''}`.trim())
      }
      return response
    }
    throw new Error('当前 adapter-onebot 版本不支持通用接口调用入口（internal._get / _request）')
  }

  // 发送公告
  async function sendGroupNotice(event: any) {
    const formatTime = (value: unknown) => {
      const date = new Date(String(value || ''))
      if (Number.isNaN(date.getTime())) return '待定'
      return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    }
    const airports = Array.isArray(event.airports) && event.airports.length
      ? event.airports.join(' → ')
      : '待定'
    const content = [
      `📢 新活动上线啦！`,
      `标题：${event.title}`,
      `时间：${formatTime(event.startsAt)} ~ ${formatTime(event.endsAt)}（北京时间）`,
      `机场：${airports}`,
      event.description ? `说明：${event.description}` : '',
      `详情：https://ceruleanavi.net/activities/${encodeURIComponent(event.id)}`,
    ].filter(Boolean).join('\n')

    const body = {
      group_id: config.groupId,
      content,
      image: 'https://ceruleanavi.net/logo.png',
    }

    try {
      const bot = ctx.bots.find((item: any) => item.platform === 'onebot' && item.isActive)
        || ctx.bots.find((item: any) => item.platform === 'onebot')
      if (!bot) {
        logger.warn('❌ 未找到可用的 OneBot 机器人，跳过公告发送')
        return
      }
      await callOneBotAction(bot, '_send_group_notice', body)
      logger.success(`✅ 已发送群公告：${event.title}`)
    } catch (err: any) {
      logger.error('❌ 公告发送异常：', err.message)
    }
  }

  // 主执行逻辑
  loadCache()

  const activityTime = (activity: any) => {
    const value = Date.parse(String(activity?.startsAt || ''))
    return Number.isFinite(value) ? value : NaN
  }

  async function fetchAsnActivities(): Promise<any[]> {
    const response = await axios.get('https://api.ceruleanavi.net/api/v1/activity/list', {
      timeout: 15000,
      headers: { Accept: 'application/json', 'User-Agent': 'Koishi ASN Event Screenshot' },
    })
    return Array.isArray(response.data?.data?.activities) ? response.data.data.activities : []
  }

  async function renderActivity(activity: any): Promise<Buffer> {
    const puppeteer = (ctx as any).puppeteer
    if (!puppeteer?.page) throw new Error('活动查询需要安装并启用 puppeteer 服务')
    const page = await puppeteer.page()
    const astroDir = join(__dirname, '..', 'astro')
    // The detail bundle imports several hashed Astro assets. Serve every local
    // asset by filename so a website deployment update cannot leave part of the
    // page loading from an incompatible remote bundle.
    const localAssets = new Map<string, string>()
    if (existsSync(astroDir)) {
      for (const entry of readdirSync(astroDir, { withFileTypes: true })) {
        if (entry.isFile()) localAssets.set(entry.name, join(astroDir, entry.name))
      }
    }
    const detailResponse = await axios.get(`https://api.ceruleanavi.net/api/v1/activity/${encodeURIComponent(activity.id)}`, {
      timeout: 15000,
      headers: { Accept: 'application/json', 'User-Agent': 'Koishi ASN Event Screenshot' },
    })
    try {
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
      await page.setRequestInterception(true)
      page.on('request', async (request: any) => {
        try {
          const requestUrl = new URL(request.url())
          if (requestUrl.pathname === `/api/v1/activity/${activity.id}`) {
            await request.respond({
              status: 200,
              contentType: 'application/json; charset=utf-8',
              body: JSON.stringify(detailResponse.data),
            })
            return
          }
          const name = request.url().split('/').pop()?.split('?')[0]
          const local = name ? localAssets.get(name) : undefined
          if (local && existsSync(local)) {
            const extension = name?.split('.').pop()?.toLowerCase()
            const contentType = extension === 'css'
              ? 'text/css; charset=utf-8'
              : extension === 'svg'
                ? 'image/svg+xml'
                : 'application/javascript; charset=utf-8'
            await request.respond({ status: 200, contentType, body: readFileSync(local) })
          } else {
            await request.continue()
          }
        } catch {
          try { await request.continue() } catch {}
        }
      })
      await page.goto(`https://ceruleanavi.net/activities/${encodeURIComponent(activity.id)}`, {
        waitUntil: 'networkidle2', timeout: 30000,
      })
      await page.waitForFunction(
        (title: string) => document.body?.innerText?.includes(title),
        { timeout: 20000 },
        String(activity.title || ''),
      )
      const content = await page.$('.mx-auto.max-w-7xl')
      return content
        ? await content.screenshot({ type: 'png' }) as Buffer
        : await page.screenshot({ type: 'png', fullPage: true }) as Buffer
    } finally {
      await page.close()
    }
  }

  ctx.command('活动列表', '查询 ASN 活动详情（仅截图）')
    .action(async () => {
      try {
        const now = Date.now()
        const candidates = (await fetchAsnActivities())
          .map(activity => ({ activity, time: activityTime(activity) }))
          .filter(item => Number.isFinite(item.time))
        // Sandbox mode can inspect archived activities. Normal mode only
        // considers activities whose scheduled start time has not arrived.
        const selected = (config.activityTestMode
          ? candidates.sort((a, b) => Math.abs(a.time - now) - Math.abs(b.time - now))
          : candidates.filter(item => item.time >= now).sort((a, b) => a.time - b.time)
        )[0]?.activity
        if (!selected) return config.activityTestMode ? '没有找到任何 ASN 活动' : '没有找到尚未开始的 ASN 活动'
        logger.info(`活动列表选择：${selected.title}（ID: ${selected.id}，活动测试开关: ${config.activityTestMode}）`)
        const image = await renderCompleteActivity(selected)
        return h.image(image, 'image/png')
      } catch (error) {
        logger.error('ASN 活动列表截图失败：', error)
        return 'ASN 活动页面截图失败，请稍后再试'
      }
    })

  // The web page is a hashed SPA bundle. Rendering directly from the detail API
  // keeps screenshots complete even when the web deployment changes its assets.
  async function renderCompleteActivity(activity: any): Promise<Buffer> {
    const puppeteer = (ctx as any).puppeteer
    if (!puppeteer?.page) throw new Error('Puppeteer service is required to render ASN activities')
    const response = await axios.get(`https://api.ceruleanavi.net/api/v1/activity/${encodeURIComponent(activity.id)}`, {
      timeout: 15000,
      headers: { Accept: 'application/json', 'User-Agent': 'Koishi ASN Event Screenshot' },
    })
    const data = response.data?.data
    if (!data?.activity) throw new Error('Invalid ASN activity detail response')

    const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
    const time = (value: unknown) => {
      const date = new Date(String(value ?? ''))
      return Number.isNaN(date.getTime()) ? '待定' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    }
    const detail = data.activity
    const routes = Array.isArray(data.routes) ? data.routes : []
    const positions = Array.isArray(data.positions) ? data.positions : []
    const registrations = Array.isArray(data.registrations) ? data.registrations : []
    const facilities: Record<string, string> = { '0': 'OBS', '1': 'FSS', '2': 'DEL', '3': 'GND', '4': 'TWR', '5': 'APP', '6': 'CTR', '7': 'SUP' }
    const ratings: Record<string, string> = { '0': 'OBS', '1': 'S1', '2': 'S2', '3': 'S3', '4': 'C1', '5': 'C2', '6': 'C3', '7': 'I1', '8': 'I2', '9': 'I3' }
    const airports = new Map<string, any[]>()
    for (const position of positions) {
      const airport = String(position.airport || '未指定机场')
      airports.set(airport, [...(airports.get(airport) ?? []), position])
    }
    const routeHtml = routes.length ? routes.map((route: any) => `<article class="route"><h3>${escape(route.departure)} <i>→</i> ${escape(route.arrival)}</h3><p><b>机型</b> ${escape(route.aircraft || '未指定')}　 <b>巡航高度</b> ${escape(route.cruise || '未指定')}</p><pre>${escape(route.route || '未提供航路')}</pre>${route.remarks ? `<p class="remark">${escape(route.remarks)}</p>` : ''}</article>`).join('') : '<p class="empty">暂无推荐航路</p>'
    const positionsHtml = airports.size ? [...airports.entries()].map(([airport, list]) => `<section class="airport"><h3>${escape(airport)}</h3><table><thead><tr><th>席位</th><th>频率</th><th>最低等级</th><th>状态</th></tr></thead><tbody>${list.map((position: any) => `<tr><td><b>${escape(position.callsign)}</b> <small>${escape(facilities[String(position.facility)] || position.facility)}</small></td><td>${escape(position.frequency || '—')}</td><td>${escape(ratings[String(position.minRating)] || position.minRating || '—')}</td><td>${position.username ? `<span class="taken">${escape(position.username)}</span>` : '<span class="open">空闲</span>'}</td></tr>`).join('')}</tbody></table></section>`).join('') : '<p class="empty">暂无管制席位</p>'
    const rosterHtml = [[0, '飞行员'], [1, '管制员'], [2, 'SUP']].map(([role, name]) => {
      const members = registrations.filter((item: any) => Number(item.role) === role)
      return `<section class="roster"><h3>${name} <small>${members.length}</small></h3><p>${members.length ? members.map((item: any) => `<span>${escape(item.username)}</span>`).join('') : '暂无报名'}</p></section>`
    }).join('')
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#1d2939;font:15px "Microsoft YaHei",Arial,sans-serif;line-height:1.6}.page{width:1360px;margin:auto;padding:42px 48px 60px}.hero{padding:32px 36px;border-radius:18px;background:linear-gradient(135deg,#12385e,#2879a5);color:#fff}.hero h1{font-size:32px;margin:4px 0 14px}.hero .eyebrow{font-size:13px;opacity:.78}.meta{display:flex;gap:12px;flex-wrap:wrap}.meta span{background:#ffffff22;padding:5px 10px;border-radius:6px}main{display:grid;grid-template-columns:2fr 1fr;gap:24px;margin-top:24px}.card{background:#fff;border:1px solid #e1e9f2;border-radius:14px;padding:25px;margin-bottom:24px;box-shadow:0 2px 8px #1720330a}h2{font-size:19px;margin:0 0 17px;padding-bottom:10px;border-bottom:1px solid #e7edf5}h3{margin:0;font-size:16px}.description{white-space:pre-wrap;color:#475569}.route{padding:17px 0;border-bottom:1px solid #e7edf5}.route:last-child{border:0;padding-bottom:0}.route i{font-style:normal;color:#6190b2;padding:0 7px}.route p{margin:8px 0}.route b{font-size:12px;color:#64748b}.route pre{white-space:pre-wrap;word-break:break-all;background:#f5f8fc;border-radius:7px;padding:11px 13px;margin:10px 0 0;font:13px Consolas,monospace}.remark{color:#64748b}.airport{margin-bottom:22px}.airport:last-child{margin:0}.airport h3{padding:8px 12px;background:#edf5fb;color:#275a82;border-radius:7px 7px 0 0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 10px;border:1px solid #e1e9f2;text-align:left}th{background:#f8fafc;color:#64748b}td small{color:#718096}.open,.taken{padding:2px 8px;border-radius:12px;font-size:12px}.open{background:#dcfce7;color:#187a42}.taken{background:#e9eef5;color:#526177}.roster{padding:12px 0;border-bottom:1px solid #e7edf5}.roster:last-child{border:0}.roster h3{display:flex;justify-content:space-between}.roster h3 small{color:#6685a6}.roster p{margin:9px 0 0;color:#718096}.roster span{display:inline-block;background:#edf4fa;color:#345978;border-radius:12px;padding:2px 8px;margin:0 5px 5px 0;font-size:13px}.empty{color:#718096}.footer{text-align:center;color:#8491a3;font-size:12px;margin-top:18px}</style><body><div class="page"><header class="hero"><div class="eyebrow">AIRWAYS NETWORK · ASN 活动详情</div><h1>${escape(detail.title)}</h1><div class="meta"><span>北京时间：${escape(time(detail.startsAt))} ～ ${escape(time(detail.endsAt))}</span><span>${detail.professional ? '专业活动' : '休闲活动'}</span><span>报名：${registrations.length}</span></div></header><main><div><section class="card"><h2>活动简介</h2><div class="description">${escape(detail.description || '暂无活动说明')}</div></section><section class="card"><h2>推荐航路</h2>${routeHtml}</section><section class="card"><h2>管制席位</h2>${positionsHtml}</section></div><aside><section class="card"><h2>报名名单</h2>${rosterHtml}</section><section class="card"><h2>活动信息</h2><p>活动 ID：${escape(detail.id)}</p><p>开放席位：${positions.filter((position: any) => !position.username).length} / ${positions.length}</p><p>详情：ceruleanavi.net</p></section></aside></main><div class="footer">数据来源 Cerulean Aviation Network · ${escape(time(new Date()))}</div></div></body></html>`
    const page = await puppeteer.page()
    try {
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 })
      await page.evaluate(async () => {
        await document.fonts?.ready
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      return await page.screenshot({ type: 'png', fullPage: true }) as Buffer
    } finally {
      await page.close()
    }
  }

  ctx.setInterval(async () => {
    try {
      const eventData = await fetchAsnActivities()
      logger.info(`✅ 成功获取 ${eventData.length} 条活动数据`)

      // 首次成功请求只建立基线，避免把 API 中的历史活动全部重发。
      if (lastTitles.size === 0) {
        for (const event of eventData) {
          if (event?.title) lastTitles.add(String(event.title))
        }
        saveCache()
        logger.info(`已建立 ${lastTitles.size} 条活动初始基线`)
        return
      }

      let cacheChanged = false
      for (const event of eventData) {
        const title = String(event?.title || '').trim()
        if (!title || lastTitles.has(title)) continue
        logger.info(`📌 发现新活动：${title}`)
        try {
          await sendGroupNotice(event)
        } finally {
          // 公告发送失败时也记录该活动，避免每次轮询重复刷屏。
          lastTitles.add(title)
          cacheChanged = true
        }
      }
      if (cacheChanged) saveCache()
    } catch (err: any) {
      if (err.response) {
        logger.warn(`❌ 活动请求失败：HTTP ${err.response.status}`)
      } else if (err.request) {
        logger.warn(`❌ 无响应：${err.message}`)
      } else {
        logger.warn(`❌ 请求出错：${err.message}`)
      }
    }
  }, config.interval * 60 * 1000)
}
