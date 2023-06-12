const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer')
const { createServer } = require('http-server')
const { Proof, Params } = require('libzkbob-rs-node')

const OUT_FLOWS_DIR = './flows/'
const TEST_FLOWS_DIR = './test-flows/'
const PARAMS = Params.fromFile(process.env.PARAMS_PATH || '../zp-relayer/params/transfer_params.bin', true)

if (!fs.existsSync(OUT_FLOWS_DIR)) {
  fs.mkdirSync(OUT_FLOWS_DIR, { recursive: true })
}

function proveTx(pub, sec) {
  return Proof.tx(PARAMS, pub, sec)
}

async function generateFlow() {
  const browser = await puppeteer.launch()
  try {
    const page = await browser.newPage()
    page.on('console', async msg => {
      const msgArgs = msg.args()
      for (let i = 0; i < msgArgs.length; ++i) {
        console.log(msgArgs[i].toString())
      }
    })
    const flowFiles = fs.readdirSync(TEST_FLOWS_DIR)
    console.log(flowFiles)
    for (let file of flowFiles) {
      console.log('Starting', file)
      const fullPath = path.join(TEST_FLOWS_DIR, file)
      const flow = require('../' + fullPath)
      await page.goto('http://127.0.0.1:8080/')
      const res = await page.evaluate(async flow => {
        await init()
        const flowOutput = await createFlow(flow)
        return flowOutput
      }, flow)

      for (let tx of res) {
        const proof = proveTx(tx.transactionData.public, tx.transactionData.secret)
        tx.proof = proof
      }

      fs.writeFileSync(`${OUT_FLOWS_DIR}/flow_${path.parse(file).name}.json`, JSON.stringify(res, null))
      console.log('Finished', file)
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const server = createServer({
    root: '.',
    cors: true,
  })
  server.listen(8080, async () => {
    try {
      await generateFlow()
    } catch (err) {
      console.log(err.toString())
    } finally {
      server.close()
    }
  })
}

main()
