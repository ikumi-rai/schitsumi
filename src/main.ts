import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js"
import { Wallet } from "@project-serum/anchor"
import bs58 from "bs58"
import { createJupiterApiClient } from "@jup-ag/api"
import { createLogger } from "./logger"
import packageJson from "../package.json"

const PRICE_API = "https://api.jup.ag/price/v2"
const USDC: Token = {
  name: "USDC",
  ca: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

// ↓ 設定項目
const TARGET: Token = {
  name: "SCHIZO",
  ca: "H1NPJkh3KUJGbpjkyQD5qG1nrpFW7tHiqek5SAbMpump",
}
const BUY_PRICE: number = 0.0195
const SELL_PRICE: number = 0.02
const USDC_AMOUNT: number = 0.1
const SLIPPAGE: number = 50 // jupiterのデフォルト値は50(0.5%)
const INIT_ACTION: Action = "buy"
const PRICE_GET_INTERVAL: number = 1000 // ミリ秒
const PRICE_LOG_INTERVAL: number = 1800 // 何回取得するごとにログを取るか。毎回記録するとログが荒れるため

type Action = "buy" | "sell"
type Token = {
  name: string
  ca: string
}
const logger = createLogger(TARGET.name)

/**
 * トークン価格を取得し、指定した金額以上/以下の場合に購入/売却
 * @param action 今回の実行時に買うか売るか
 * @param logPrice 価格のログを取るかどうか
 * @returns 次回の実行時に買うか売るか
 */
const main_ = async (action: Action, logPrice: boolean): Promise<Action> => {
  const price = await getPrice(TARGET)
  if (price === false) return stop(MSG.error.price)
  if (logPrice) logger.info(MSG.info.price(TARGET, price))
  switch (action) {
    case "buy": {
      if (price > BUY_PRICE) return "buy"
      await sleep(1500) // サンドイッチ中の価格に騙されないよう1.5秒後に価格を再取得
      const newPrice = await getPrice(TARGET)
      if (newPrice === false) return stop(MSG.error.price)
      if (newPrice > BUY_PRICE) return "buy"
      logger.info(MSG.info.buy(BUY_PRICE))
      const txId = await swap(USDC, TARGET, USDC_AMOUNT, SLIPPAGE)
      if (txId === false) return stop(MSG.error.swap)
      logger.info(MSG.info.swap.done(txId))
      return "sell"
    }
    case "sell": {
      if (price < SELL_PRICE) return "sell"
      await sleep(1500) // 同上
      const newPrice = await getPrice(TARGET)
      if (newPrice === false) return stop(MSG.error.price)
      if (newPrice < SELL_PRICE) return "sell"
      logger.info(MSG.info.sell(SELL_PRICE))
      const txId = await swap(TARGET, USDC, USDC_AMOUNT / newPrice, SLIPPAGE)
      if (txId === false) return stop(MSG.error.swap)
      logger.info(MSG.info.swap.done(txId))
      return "buy"
    }
  }
}

/**
 * main_()関数を${PRICE_GET_INTERVAL}ミリ秒間隔で無限ループ
 */
const main = async (): Promise<never> => {
  if (!checkDotEnv()) stop(MSG.error.dotenv)
  console.log(MSG.info.start)
  logger.info({
    TARGET,
    BUY_PRICE,
    SELL_PRICE,
    USDC_AMOUNT,
    SLIPPAGE,
    INIT_ACTION,
    PRICE_GET_INTERVAL,
    PRICE_LOG_INTERVAL,
  })
  let nextAction: Action = INIT_ACTION
  let i = 0
  while (true) {
    const startTime = performance.now()
    nextAction = await main_(nextAction, !i)
    const endTime = performance.now()
    const waitTime = PRICE_GET_INTERVAL - (endTime - startTime)
    if (waitTime > 0) await sleep(waitTime)
    i++
    if (i === PRICE_LOG_INTERVAL) i = 0
  }
}

/**
 * 指定ミリ秒停止
 */
const sleep = (ms: number): Promise<unknown> => {
  return new Promise((res) => setTimeout(res, ms))
}

/**
 * ログを取ってexit
 */
const stop = (msg: string): never => {
  logger.error(msg)
  process.exit(1)
}

/**
 * .envを正しく読み込んでいるか確認
 */
const checkDotEnv = (): boolean => {
  return !!(process.env.RCP_ENDPOINT && process.env.PUBLIC_KEY && process.env.PRIVATE_KEY)
}

/**
 * Jupiter APIでトークン価格を取得。なんらかのエラーが発生した場合にはfalseを返す
 */
const getPrice = async (token: Token, api = PRICE_API): Promise<number | false> => {
  const price = await fetch(
    `${api}?` +
      new URLSearchParams({
        ids: token.ca,
      }),
  )
    .then(async (res) => {
      if (res.status !== 200) return false as const
      const json = await res.json()
      return Number(json.data[token.ca].price)
    })
    .catch(() => false as const)
  return price
}

const jupiter = createJupiterApiClient()
const connection = new Connection(process.env.RCP_ENDPOINT || "https://dummy.xyz")
const walletKeys = {
  public: process.env.PUBLIC_KEY || "",
  private: bs58.decode(process.env.PRIVATE_KEY || ""),
}
const wallet = new Wallet(Keypair.fromSecretKey(walletKeys.private))

/**
 * Jupiter APIでスワップトランザクションを作成し、RPCサーバーを介して実行。なんらかのエラーが発生した場合にはfalseを返す
 * @returns 確認済みトランザクションID
 */
const swap = async (
  from: Token,
  to: Token,
  amount: number,
  slippage: number,
): Promise<string | false> => {
  // 最適経路取得
  const resQuote = await jupiter
    .quoteGet({
      inputMint: from.ca,
      outputMint: to.ca,
      amount: Math.floor(amount * 1_000_000), // 小数点第6位までを整数に変換して渡す
      slippageBps: slippage,
    })
    .catch(() => false as const)
  if (resQuote === false) return false
  logger.info(
    MSG.info.swap.amount(
      from.name,
      Number(resQuote.inAmount) / 1_000_000,
      to.name,
      Number(resQuote.outAmount) / 1_000_000,
    ),
  )

  // トランザクション作成
  const resSwap = await jupiter
    .swapPost({
      swapRequest: {
        userPublicKey: walletKeys.public,
        quoteResponse: resQuote,
      },
    })
    .catch(() => false as const)
  if (resSwap === false) return false
  const swapTx = VersionedTransaction.deserialize(Buffer.from(resSwap.swapTransaction, "base64"))
  swapTx.sign([wallet.payer])
  logger.info(MSG.info.swap.createdTx)

  // トランザクション送信
  const latestBlock = await connection.getLatestBlockhash().catch(() => false as const)
  if (latestBlock === false) return false
  const txId = await connection
    .sendRawTransaction(swapTx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    })
    .catch(() => false as const)
  if (txId === false) return false
  logger.info({ transactionId: txId }, MSG.info.swap.sentTx)

  // トランザクション確認
  const resRpc = await connection
    .confirmTransaction({
      blockhash: latestBlock.blockhash,
      lastValidBlockHeight: latestBlock.lastValidBlockHeight,
      signature: txId,
    })
    .catch(() => false as const)
  if (resRpc === false) return false
  logger.info({ transactionId: txId }, MSG.info.swap.confirmedTx)

  return txId
}

const MSG = {
  info: {
    start: `\nすちつみ ver.${packageJson.version}\n終了する際はCtrl+Cを押してください。\n`,
    price: (token: Token, price: number) => `現在の$${token.name}の価格は$${price}です。`,
    buy: (price: number) => `トークン価格が$${price}を下回りました。購入処理を開始します。`,
    sell: (price: number) => `トークン価格が$${price}を上回りました。売却処理を開始します。`,
    swap: {
      amount: (fromName: string, fromAmt: number, toName: string, toAmt: number) =>
        `予定数量: $${fromName} ${fromAmt} ⇆ $${toName} ${toAmt}`,
      createdTx: "トランザクションを作成しました。トランザクションを送信します…",
      sentTx: "トランザクションを送信しました。トランザクションを確認します…",
      confirmedTx: "トランザクションを確認しました。",
      done: (transactionId: string) =>
        `スワップが完了しました。https://solscan.io/tx/${transactionId}`,
    },
  },
  error: {
    dotenv: ".envの記載が正しくないか、読み込みに失敗しました。詳しくは.READMEを確認してください。",
    price: "価格の取得に失敗しました。処理を終了します。",
    swap: "スワップに失敗しました。処理を終了します。",
  },
}

main()
