// @ts-ignore
import cors from 'cors'
import { Signer } from 'ethers'
import { toBN } from 'web3-utils'
import express, { NextFunction, Request, Response } from 'express'
import { checkSignMPCSchema, validateBatch } from '../validation/api/validation'
import { logger } from '../services/appLogger'
import { TxDataMPC, validateTxMPC } from '../validation/tx/validateTx'
import { TxData, buildTxData } from '@/txProcessor'
import { numToHex, truncateHexPrefix } from '@/utils/helpers'
import { VK } from 'libzkbob-rs-node'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import { ENERGY_SIZE, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import config from '@/configs/guardConfig'
import type { Network, NetworkContract } from '@/services/network'

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
  signer: Signer
  poolContract: NetworkContract<Network>
}

export function createRouter({ signer, poolContract }: RouterConfig) {
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
      const vk: VK = require('../params/tree_verification_key.json') // TODO: config vk

      const denominator = toBN(await poolContract.call('denominator'))
      const poolId = toBN(await poolContract.call('pool_id'))

      try {
        await validateTxMPC(message, config.GUARD_RELAYER_ADDRESS, poolContract, poolId, denominator, vk, vk)
      } catch (e) {
        console.log('Validation error', e)
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
        depositSignature: null,
      }
      const calldata = truncateHexPrefix(buildTxData(txData))
      const signature = await signer.signMessage(calldata)

      res.json({ signature })
    })
  )

  return router
}
