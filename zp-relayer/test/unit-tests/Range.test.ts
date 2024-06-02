import { expect } from 'chai'
import { Range } from '../../utils/Range'

describe('Range', () => {
  it('correctly iterates bounded range', () => {
    // Positive step
    expect(Array.from(new Range({ start: 0, end: 10, step: 2 }))).eql([
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 10],
    ])

    expect(Array.from(new Range({ start: 0, end: 9, step: 2 }))).eql([
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 9],
    ])

    expect(Array.from(new Range({ start: 10, end: 9, step: 1 }))).eql([])

    // Negative step
    expect(Array.from(new Range({ start: 5, end: 1, step: -2 }))).eql([
      [5, 3],
      [2, 1],
    ])

    expect(Array.from(new Range({ start: 0, end: 5, step: -2 }))).eql([])
  })
})
