// Standalone script: npm run poll
import { loadListings, loadFeatured } from '../src/listings.js'
import { pollBazaar } from '../src/aggregators/bazaar.js'
import { pollSatring } from '../src/aggregators/satring.js'
import { pollL402Apps } from '../src/aggregators/l402apps.js'
import { pollL402Directory } from '../src/aggregators/l402directory.js'
import { pollPayai } from '../src/aggregators/payai.js'

async function main() {
  loadListings()
  await pollBazaar()
  await pollPayai()
  await pollSatring()
  await pollL402Apps()
  await pollL402Directory()
  loadFeatured()
  process.exit(0)
}

main().catch(err => {
  console.error('[poll] Fatal error:', err)
  process.exit(1)
})
