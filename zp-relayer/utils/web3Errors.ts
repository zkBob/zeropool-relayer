export function isGasPriceError(e: Error) {
  const message = e.message.toLowerCase()
  return message.includes('replacement transaction underpriced')
}

export function isSameTransactionError(e: Error) {
  const message = e.message.toLowerCase()
  return (
    message.includes('transaction with the same hash was already imported') ||
    message.includes('already known') ||
    message.includes('alreadyknown') ||
    message.includes('transaction already imported')
  )
}

export function isNonceError(e: Error) {
  const message = e.message.toLowerCase()
  return (
    message.includes('transaction nonce is too low') ||
    message.includes('nonce too low') ||
    message.includes('transaction with same nonce in the queue') ||
    message.includes('oldnonce') ||
    message.includes(`the tx doesn't have the correct nonce`)
  )
}

export function isInsufficientBalanceError(e: Error) {
  const message = e.message.toLowerCase()
  return message.includes('insufficient funds')
}

export function isContractCallError(e: Error) {
  const message = e.message.toLowerCase()
  return message.includes('did it run out of gas')
}
