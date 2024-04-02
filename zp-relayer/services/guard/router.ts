import config from '@/configs/guardConfig'
import type { Network, NetworkContract } from '@/lib/network'
// @ts-ignore
import { buildTxData, TxData } from '@/txProcessor'
import { ENERGY_SIZE, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import { numToHex, packSignature } from '@/utils/helpers'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import cors from 'cors'
import { getBytes, keccak256 } from 'ethers'
import express, { NextFunction, Request, Response } from 'express'
import { VK } from 'libzkbob-rs-node'
import { logger } from '@/lib/appLogger'
import { checkSignMPCSchema, validateBatch } from '@/validation/api/validation'
// @ts-ignore
import TronWeb from 'tronweb'
import { toBN } from 'web3-utils'
// @ts-ignore
import { TxDataMPC, validateTxMPC } from '@/validation/tx/validateTx'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

interface RouterConfig {
  poolContract: NetworkContract<Network>
}

export function createRouter({ poolContract }: RouterConfig) {
  const router = express.Router()

  router.use(cors())
  router.use(express.urlencoded({ extended: true }))
  router.use(express.json())
  router.use(express.text())

  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err) {
      logger.error('Request error:', err)
      return res.sendStatus(500)
    }
    next()
  })

  router.post(
    '/sign',
    wrapErr(async (req: Request, res: Response) => {
      validateBatch([[checkSignMPCSchema, req.body]])
      const message = req.body as TxDataMPC

      // Validate
      const txVK: VK = require(config.GUARD_TX_VK_PATH)
      const treeVK: VK = require(config.GUARD_TREE_VK_PATH)

      const poolId = toBN(await poolContract.call('pool_id'))

      try {
        await validateTxMPC(message, poolId, treeVK, txVK)
      } catch (e) {
        logger.error('Validation error', e)
        throw new Error('Invalid transaction')
      }

      // Sign
      const { txProof, treeProof } = message
      const nullifier = getTxProofField(txProof, 'nullifier')
      const outCommit = getTxProofField(txProof, 'out_commit')
      const delta = parseDelta(getTxProofField(txProof, 'delta'))

      const rootAfter = treeProof.inputs[1]

      const txData: TxData = {
        txProof: message.txProof.proof,
        treeProof: message.treeProof.proof,
        nullifier: numToHex(toBN(nullifier)),
        outCommit: numToHex(toBN(outCommit)),
        rootAfter: numToHex(toBN(rootAfter)),
        delta: {
          transferIndex: numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE),
          energyAmount: numToHex(delta.energyAmount, ENERGY_SIZE),
          tokenAmount: numToHex(delta.tokenAmount, TOKEN_SIZE),
        },
        txType: message.txType,
        memo: message.memo,
        depositSignature: message.depositSignature,
      }

      const transferRoot = numToHex(toBN(getTxProofField(txProof, 'root')))
      const currentRoot = numToHex(toBN(treeProof.inputs[0]))
      logger.debug(`Using transferRoot: ${transferRoot}; Current root: ${currentRoot}; PoolId ${poolId}`)

      let calldata = buildTxData(txData)
      calldata += transferRoot + currentRoot + numToHex(poolId)

      logger.debug(`Signing ${calldata}`)
      const digest = getBytes(keccak256(calldata))
      const signature = packSignature(await TronWeb.Trx.signMessageV2(digest, config.GUARD_ADDRESS_PRIVATE_KEY))

      logger.info(`Signed ${signature}}`)
      res.json({ signature })
    })
  )

  return router
}
