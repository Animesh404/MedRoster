import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom component tests render into a shared document; without an explicit
// cleanup a later test in the same file inherits the previous test's DOM
// (e.g. two elements matching `role="status"` instead of one).
afterEach(() => {
  cleanup()
})
