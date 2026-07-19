import { Context, Schema, Logger } from 'koishi'
import axios from 'axios'
import axiosRetry from 'axios-retry'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface Config {
  groupId: number
  interval: number
}

export const Config: Schema<Config> = Schema.object({
  groupId: Schema.number().description('目标群号（UIN）'),
  interval: Schema.number().default(10).description('检查新活动的间隔时间（分钟）'),
})

const STORAGE_PATH = join(__dirname, 'last-events.json')

export default function apply(ctx: Context, config: Config) {
  const logger = new Logger('airwaysn-event')
  let lastTitles = new Set<string>()

  // 请求失败时自动重试
  axiosRetry(axios, {
    retries: 3,
    retryDelay: (count) => count * 1000,
    retryCondition: (err) => err.response?.status >= 500,
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

  // 发送公告
  async function sendGroupNotice(event: any) {
    const content = [
      `📢 新活动上线啦！`,
      `标题：${event.title}`,
      `时间：${event.time.from} ~ ${event.time.to}（${event.time.timezone}）`,
      `机场：${event.airports.join(' → ')}`,
      `航路：${event.route}`,
    ].join('\n')

    const body = {
      group_id: config.groupId,
      content,
      image: 'https://airwaysn.org/logo.png',
    }

    try {
      const res = await axios.post('http://localhost:5700/_send_group_notice', body)
      if (res.data?.status === 'ok') {
        logger.success(`✅ 已发送群公告：${event.title}`)
      } else {
        logger.warn('❌ 群公告失败：', res.data)
      }
    } catch (err) {
      logger.error('❌ 公告发送异常：', err.message)
    }
  }

  // 主执行逻辑
  loadCache()

  ctx.setInterval(async () => {
    try {
      const res = await axios.get('https://airwaysn.org/api/v1/event')
      const eventData = res.data?.eventData || []
      logger.info(`✅ 成功获取 ${eventData.length} 条活动数据`)

      for (const event of eventData) {
        if (!lastTitles.has(event.title)) {
          logger.info(`📌 发现新活动：${event.title}`)
          await sendGroupNotice(event)
          lastTitles.add(event.title)
          saveCache()
        }
      }
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
