import * as dotenv from 'dotenv'
import { CrewProfile } from './crew3-module'
import * as google from './answers-database'

import { Telegraf, Context } from 'telegraf'
import { Keyboard, Key, MakeOptions, KeyboardButton } from 'telegram-keyboard'
import LocalSession from 'telegraf-session-local'

import { promises as fs } from 'fs'
import { JsonRpcProvider } from '@ethersproject/providers'
import { formatEther, parseEther } from '@ethersproject/units'
import { Wallet } from '@ethersproject/wallet'

import delay from 'delay'
import axios from 'axios'
import { HeaderGenerator } from 'header-generator'
const headerGenerator = new HeaderGenerator({
  browserListQuery: 'last 5 chrome versions',
  operatingSystems: ['windows', 'macos', 'ios', 'android']
})

dotenv.config()

// Constants
const CLAIM_TIMEOUT = parseInt(process.env.CLAIM_TIMEOUT)
const SHORT_TIMEOUT = parseInt(process.env.SHORT_TIMEOUT)
const ADMIN = parseInt(process.env.ADMIN_ID)

// Ethers
const provider = new JsonRpcProvider('goerli')

// Telegram initialize
interface SessionData {
  currentProfile: string
  invite: {}
  accounts: {}
}
interface BotContext extends Context {
  session?: SessionData
}
export const bot = new Telegraf<BotContext>(process.env.BOT_TOKEN, { handlerTimeout: 90_000_000 })

// Bot middlewares
bot
  // Setup local database
  .use((new LocalSession({ database: 'sessions.json' })).middleware())
  // Block other users
  .use((ctx, next) => {
    if (ctx.from.id !== ADMIN)
      return ctx.reply('Access Denied!!!')
    if (!ctx.session.accounts)
      ctx.session.accounts = {}
    return next()
  })

// Keyboards
const mainKeyboard = (ctx: BotContext) => {
  const hide = Object.values(ctx.session.accounts).length === 0
  return [
    [ Key.callback('🍪 Add Crew3 account(s) »', 'add_profile') ],
    [ Key.callback('📑 Manage all accounts »', 'all_accounts', hide) ],
    [ Key.callback('🌀 Claim Daily/none quests »', 'claim_none_all', hide) ],
    [ Key.callback('👨‍💻 Claim Quiz & Questions »', 'claim_quiz_all', hide) ],
    // [ Key.callback('🐔 Claim Discord & Twitter quests »', 'claim_social_all', hide) ],
    [ Key.callback('🧙‍♂️ Batch Invite to communities»', 'invite', hide) ],
    [ Key.callback('👋 Batch Leave communities»', 'leave', hide) ],
  ]
}

const profileInfo = async (user, communities) => 
  `Fetch *${user.name}* crew3 profile!

Twitter: ${user.twitterUsername ? `[${user.twitterUsername}](https://twitter.com/${user.twitterUsername})` : 'NONE'}
Discord: ${user.discordHandle ? `[${user.discordHandle}](https://discord.com/app)` : 'NONE'}

[${user.ethWallet}](https://debank.com/profile/${user.ethWallet})

Profile joined to *${communities.length} communities*: \`${communities.map(i => i.name).join('\`, \`')}\`

_Choose action:_
`
//NFT|DAO|Art|Music|Collectibles|Gaming|DeFi|Metaverse|Trading Cards|Infrastructure|Education|Startup|Protocol|Investing|DeSci|new
const profileButtons = (user) => [
  [ Key.callback('Daily Connect »', `claim_none_${user.id}`), Key.callback('Quiz & questions »', `claim_quiz_${user.id}`) ],
  [ Key.callback('Discord »', `claim_discord_${user.id}`), Key.callback('Twitter »', `claim_twitter_${user.id}`) ],
  [
    Key.callback('Rank and Level »', `level_${user.id}`), 
    Key.callback('Get all invites »', `invites_${user.id}`) 
  ], 
  [
    Key.callback('Share Quiz answers »', `answers_${user.id}`) 
  ],
  [ 
    Key.callback('New', `communities_new_${user.id}`), 
    Key.callback('Infrastructure', `communities_Infrastructure_${user.id}`),
    Key.callback('Protocol', `communities_Protocol_${user.id}`),
  ],
  [ 
    Key.callback(`Startup`, `communities_Startup_${user.id}`),
    Key.callback('NFT', `communities_NFT_${user.id}`),
    Key.callback('Education', `communities_Education_${user.id}`),
  ], 
  [ 
    Key.callback('« Back to accounts', `all_accounts`),
    Key.callback('! Remove profile !', `delete_${user.id}`)
  ],
  [ Key.callback('« Main menu', `main`) ]
]

// Helper functions
const getCrewByMatch = (ctx, index = 1) =>
  new CrewProfile(ctx.session.accounts[ctx.match[index]].crew_headers)

const getAccountName = (ctx, id) => ctx.session.accounts[id] ? (ctx.session.accounts[id].crew_user.name || ctx.session.accounts[id].crew_user.discordHandle || ctx.session.accounts[id].crew_user.twitterUsername) : 'NONE'

// Main functions
const claimQuestWithReport = async (ctx : BotContext, id, types = ['none'], answers) => {
  ctx.answerCbQuery('Please wait...')
  const crew = new CrewProfile(ctx.session.accounts[id].crew_headers)
  const userCommunities = await crew.getUserCommunities()
  if (userCommunities) {
    await ctx.reply('Claim processing, please wait logging message...', { parse_mode: 'Markdown' })
      .then(async (m) => {
        const report = await crew.claimQuestsByType(userCommunities, types, CLAIM_TIMEOUT, answers)
        await bot.telegram.editMessageText(ctx.from.id, m.message_id, m.message_id.toString(), `*${getAccountName(ctx, id)}:*\n${report.join('\n')}`, Keyboard
        .make([[ Key.callback('« Main menu', 'main'), Key.callback('To account »', `account_${id}`) ]])
        .inline({ parse_mode: 'Markdown' })).catch(e => ctx.reply('Report too long...'))
      })
  }
}

const getCookieByPrivateKey = async (ctx, key) => {
  try {
    const signer = new Wallet(key.toString(), provider)
    const headers = headerGenerator.getHeaders()
    headers.origin = "https://crew3.xyz"
    const api = axios.create({ baseURL: 'https://api.crew3.xyz/', headers: headers })
    await api
      .post("authentification/wallet/nonce", { address: signer.address })
      .then(async (r) => {
        return api.post('authentification/wallet/verify-signature', {
          sessionId: r.data.id,
          signature: await signer.signMessage(r.data.nonce)
        }).then(async (r) => {
          if (r.data === 'OK') {
            const cookie = r.headers['set-cookie']
            cookie.push('cookieConsent=true')
            cookie.push('subdomain=root')

            headers['cookie'] = cookie.join('; ')
            
            const crew = new CrewProfile(headers)
            const user = await crew.getUser()
            
            if (!user || user.accounts.length < 2)
              return ctx.replyWithMarkdown(`Found address: _${signer.address}_\nLooks like he doesn't have a Crew3 profile or connected social accounts :(`)

            ctx.session.accounts[user.id] = {
              crew_user: user,
              crew_headers: headers
            }
            return true
          } else {
            return ctx.reply(`Something wrong - ${signer.address}`)
          }
        })
        .catch(e => {
          console.log(e)
          return ctx.reply(`Another error - ${signer.address}`)
        })
    }).catch(e => {
      console.log(e)
      return ctx.reply(`Сouldn't get a nonce from Crew3 website - ${signer.address}`)
    })
  } catch (e) {
    console.log(e)
    return ctx.reply(`Invalid private key!`) 
  }
}

// Batch join command
const join = async (ctx, ids, link) => {
  let joined = 0
  for (const id of ids) {
    if (joined < ctx.session.invite.max) {
      const crew = new CrewProfile(ctx.session.accounts[id].crew_headers)
      const state = await crew.joinByReferral(ctx.session.invite.subdomain, ctx.session.invite.code)
      if (state.startsWith('Success')) joined++
      console.log(state)
      await ctx.reply(`*${getAccountName(ctx, id)}:* ${state}`, { parse_mode: 'Markdown' })
      await delay(SHORT_TIMEOUT)
    }
  }
  return ctx.reply(`Joined ${joined} accounts complete!`)
}

bot
  .hears(/https:\/\/(.*).crew3.xyz\/invite\/([\S]+)\s?(\d?)/, async (ctx) => {
    ctx.session.invite = {
      subdomain: ctx.match[1],
      code: ctx.match[2],
      max: ctx.match[3] !== '' ? parseInt(ctx.match[3]) : Object.keys(ctx.session.accounts).length
    }
    const buttons = [
      [
        Key.callback(getAccountName(ctx, ctx.session.currentProfile), 'last_account_' + ctx.session.currentProfile, !ctx.session.currentProfile),
        Key.callback(`${ctx.match[3] !== '' ? ctx.match[3] : 'All'} accounts »`, 'all_accounts_lastRefLink'),
      ], [
        Key.callback('« Main menu', 'main')
      ],
    ]
    const actions = Keyboard.make(buttons).inline({ parse_mode: 'Markdown', disable_web_page_preview: true })
    ctx.reply(`Select account(s) join to *${ctx.match[1]}* community?`, actions)
  })
  .action(/last_account_(.+)/, async (ctx) => {
    return join(ctx, [ctx.session.currentProfile], ctx.session.invite)
  })
  .action(/all_accounts_(.+)/, async (ctx) => {
    return join(ctx, Object.keys(ctx.session.accounts), ctx.session.invite)
  })

// Batch leave command
bot
  .hears(/leave (.*)/, async (ctx) => {
    const crew = new CrewProfile(headerGenerator.getHeaders())
    const community = await crew.searchCommunity(ctx.match[1])
    const buttons = [
      [
        Key.callback('« Main menu', 'main'),
        Key.callback('Leave »', 'leave_' + community.subdomain)
      ],
    ]
    const actions = Keyboard.make(buttons).inline({ parse_mode: 'Markdown'})
    return ctx.reply(`Leave community *${community.name}*?`, actions)
  })
  .action(/leave_(.+)/, async (ctx) => {
    for (const id of Object.keys(ctx.session.accounts)) {
      const crew = new CrewProfile(ctx.session.accounts[id].crew_headers)
      await ctx.reply(`*${getAccountName(ctx, id)}:* ${await crew.leaveCommunity(ctx.match[1], ctx.session.accounts[id].crew_user)}`, { parse_mode: 'Markdown' })
      await delay(SHORT_TIMEOUT)
    }
    return ctx.reply('Operation complete')
  })
  
// Main menu
const main = async (ctx: BotContext, msg = null) => {
  if (msg) {
    await ctx.replyWithMarkdown(msg)
    await delay(1000)
  }
  
  let text = `Let's *f#$%ing* automate this boring!`

  const accounts = Object.entries(ctx.session.accounts)
  if (accounts.length > 0) {
    text += `\n\nYou have *${accounts.length}* account for work.`
    text += `\n\n_Select action:_`
  }
  
  const actions = Keyboard.make(mainKeyboard(ctx)).inline({ parse_mode: 'Markdown', caption: text })

  return ctx.replyWithPhoto('https://aptos-mainnet-api.bluemove.net/uploads/nuclear_8cbc4d5fb5.png', actions)
}

// Bot commands and actions
bot.command('start', async (ctx) => main(ctx))
  .action('add_profile', async (ctx) => {
    await ctx.replyWithMarkdown(`_Method 1:_ Send *private key* of wallet and bot try to log in to Crew3 account!\n\n_Method 2:_ Edit file \`accounts.csv\` in root of bot directory and click this button again.`)
    try {
      const accounts = (await fs.readFile('accounts.csv', 'utf8')).split('\n')
      if (accounts.length > 0) {
        ctx.reply(`File \`accounts.csv\` parsed, found ${accounts.length} keys...`)
        for (const account of accounts) {
          const address = account.split(';')[0]
          if (!ctx.session.accounts[address])
            await getCookieByPrivateKey(ctx, account.split(';')[1])
          else ctx.reply(`${address} already added to bot session!`)
        }
      }
    } catch (e) {
      console.log(e)
    }
  })
  .hears(/[a-fA-F0-9]{64}/g, async (ctx) => {
    await ctx.deleteMessage()
    await ctx.replyWithMarkdown(`*OK, start connecting...*\n_Private key was removed for security purposes!_`)
    for (const key of ctx.message.text.matchAll(/[a-fA-F0-9]{64}/g)) {
      await getCookieByPrivateKey(ctx, key)
    }
    return main(ctx, `Done key(s) processing!`)
  })
  .action('all_accounts', async (ctx) => {
    if (ctx.session.accounts) {
      let buttons = Object.values(ctx.session.accounts).map(({ crew_user: account }: any) => [Key.callback(account.name || account.discordHandle || account.twitterUsername, 'account_' + account.id)])
      buttons.push([Key.callback('« Main menu', 'main')])
      const accounts = Keyboard.make(buttons, {
        pattern: [2, 1],
        columns: 2,
        wrap: () => true,
        filter: () => true,
        filterAfterBuild: false,
        flat: true
      }).inline({ parse_mode: 'Markdown'})
      ctx.reply(`*Choose account to view:*`, accounts)
    } else {
      ctx.reply(`You don't have accounts`, )
    }
  })
  .action(/account_(.+)/, async (ctx) => {
    const crew = await getCrewByMatch(ctx, 1)
    const user = await crew.getUser()
    const communities = await crew.getUserCommunities()
    const actions = Keyboard.make(profileButtons(user)).inline({ parse_mode: 'Markdown', disable_web_page_preview: true })
    ctx.session.currentProfile = ctx.match[1]
    return ctx.reply(await profileInfo(user, communities), actions)
  })
  .action(/answers_(.+)/, async (ctx) => {
    const crew = await getCrewByMatch(ctx, 1)
    let url = ''
    for (const community of await crew.getUserCommunities())
      url = await google.writeAnswers(await crew.getCommunityAnswers(community, 0, 500))
    return ctx.reply(`Answers are recorded in a Google SpreadSheets: ${url}`)
  })
  .action('main', async (ctx) => main(ctx))
  .action('invite', async (ctx) => ctx.replyWithMarkdown(`Send invite link to bot, you can setup how many invitesmust be, example:
  
*[invite link from crew3]* *[number of invites]*
  `, { disable_web_page_preview: true }))
  .action('leave', (ctx) => ctx.replyWithMarkdown('Send to bot command /leave *[subdomain]*'))
  .action(/level_(.+)/, async (ctx) => {
    const crew = getCrewByMatch(ctx, 1)
    const user = await crew.getUser()
    for (const community of await crew.getUserCommunities()) {
      const message = await crew.communityMessage(community, user)
      await ctx.reply(message, Keyboard
        .make([[
          Key.callback('« Leave community', `leave_${user.id}`),
          Key.callback('Get invite link »', `invite_${community.subdomain}_${user.id}`)
        ], [
          Key.callback('« Main menu', `main`),
          Key.callback('Account »', `account_${ctx.match[1]}`)
        ]]).inline({
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }))
    }
  })
  .action(/invite_(.*)_(.+)/, async (ctx) => {
    const crew = getCrewByMatch(ctx, 2)
    ctx.reply(await crew.getReferralLink(ctx.match[1]))
  })
  .action(/invites_(.+)/, async (ctx) => {
    const crew = getCrewByMatch(ctx, 1)
    const report = []
    for (const community of await crew.getUserCommunities())
      report.push(`*${community.name}*\n\`${await crew.getReferralLink(community.subdomain)}\``)
    return ctx.reply(report.join('\n'), { parse_mode: 'Markdown', disable_web_page_preview: true })
  })
  .action(/communities_([NFT|DAO|Art|Music|Collectibles|Gaming|DeFi|Metaverse|Trading Cards|Infrastructure|Education|Startup|Protocol|Investing|DeSci|new]+)_(.+)/, async (ctx) => {
    const crew = getCrewByMatch(ctx, 2)
    const user = await crew.getUser()
    const joined = (await crew.getUserCommunities()).map(community => community.name)
    const communities = await crew.getCommunities(ctx.match[1], 1, 0)
    for (const community of communities) {
      const message = await crew.communityMessage(community, user)
      await ctx.reply(message, Keyboard
        .make([[ Key.callback('« Leave community', `leave_${user.id}`, !joined.includes(community.name)) ],
          [ Key.callback('Join »', `join_${user.id}`, joined.includes(community.name)) ],
          [
            Key.callback('« Main menu', `main`),
            Key.callback('Account »', `account_${ctx.match[1]}`)
          ]
        ])
        .inline({
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }))
    }
  })
  .action(/claim_([none|quiz]+)_(.+)/, async (ctx) => {
    const ids = ctx.match[2] !== 'all'
      ? [ ctx.match[2] ]
      : Object.keys(ctx.session.accounts)
    const answers = await google.readAnswers()

    for (const id of ids)
      await claimQuestWithReport(ctx, id, ctx.match[1] === 'quiz' ? ['quiz', 'text'] : ['none'], answers)

    return
  })
  .action(/claim_([discord|twitter|social]+)_(.+)/, async (ctx) => {
    const ids = ctx.match[2] !== 'all'
      ? [ ctx.match[2] ]
      : Object.keys(ctx.session.accounts)
    const answers = await google.readAnswers()

    for (const id of ids)
      await claimQuestWithReport(ctx, id, ctx.match[1] === 'social' ? ['twitter', 'discord'] : [ ctx.match[1] ], answers)

    return ctx.reply('Wait for next update for auto-task, now only auto-claim supported.')
  })
  .action(/delete_(.+)/, async (ctx) => {
    const address = ctx.session.accounts[ctx.match[1]].crew_user.ethWallet
    delete ctx.session.accounts[ctx.match[1]]
    return main(ctx, `Account \`${address}\` deleted, to recover send it private key again`)
  })
  .hears(/search (.*)/, async (ctx) => {
    const crew = new CrewProfile(headerGenerator.getHeaders())
    const community = await crew.searchCommunity(ctx.match[1])
    if (community) {
      ctx.session.invite = {
        subdomain: community.subdomain,
        code: null,
        max: 1
      }
      const message = await crew.communityMessage(community)
      await ctx.reply(message, Keyboard
        .make([
          [ Key.callback('Join »', `join_${ctx.session.currentProfile}`, !ctx.session.currentProfile) ],
          [ Key.callback('« Main menu', `main`)]
        ]).inline({
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }))
    }
  })

// Any other message
bot.on('message', (ctx) => main(ctx))

bot.catch((e, ctx) => {
  console.log('Error', e)
  ctx.reply(JSON.stringify(e))
})

bot.launch()
  .then(async () => {
    //bot.telegram.sendMessage(ADMIN, 'Bot launched')
  })
  .catch(e => console.log(e))