import test from 'node:test'
import assert from 'node:assert/strict'
import { makeListing } from '../src/normalize.js'
import { applyListingFilters } from '../src/legacy-listing-filter.js'

const base = {
  propertyType: 'any', dealType: 'any', agency: 'any', audience: 'any',
  sources: [], city: '', district: '', metro: '', query: '', listingId: '',
}

function filter(items, extra) {
  return applyListingFilters(items, { ...base, ...extra })
}

const listing = {
  id: '1', source: 'olx', country: 'UZ', propertyType: 'flat', dealType: 'longRent',
  byAgency: false, price: 800, currency: 'USD', rooms: 3, bedrooms: 2,
  areaSqm: 78, floor: 6, totalFloors: 12, buildingYear: 2024, newBuilding: true,
  petsAllowed: true, childrenAllowed: true, roomOnly: false, commercial: false,
  createdAt: new Date().toISOString(), city: 'Tashkent', district: 'Chilanzar', metro: 'Chilonzor',
  title: 'Apartment', description: '', tags: [],
}

test('filters by area range', () => {
  assert.equal(filter([listing], { areaMin: 70, areaMax: 80 }).length, 1)
  assert.equal(filter([listing], { areaMin: 79 }).length, 0)
})

test('filters by listing floor and building floor count independently', () => {
  assert.equal(filter([listing], { floorMin: 5, floorMax: 7 }).length, 1)
  assert.equal(filter([listing], { totalFloorsMin: 10, totalFloorsMax: 15 }).length, 1)
  assert.equal(filter([listing], { totalFloorsMax: 10 }).length, 0)
})

test('new building filter requires normalized newBuilding true', () => {
  assert.equal(filter([listing], { newBuilding: true }).length, 1)
  assert.equal(filter([{ ...listing, newBuilding: null }], { newBuilding: true }).length, 0)
})

test('normalization treats buildings within five years as new', () => {
  const year = new Date().getFullYear() - 5
  const normalized = makeListing({
    id: 'new-by-year', source: 'olx', country: 'UZ', title: `Apartment built ${year}`,
    description: '', propertyType: 'flat', buildingYear: year,
  })
  assert.equal(normalized.newBuilding, true)
})

test('pet and room filters are strict', () => {
  assert.equal(filter([listing], { pets: true }).length, 1)
  assert.equal(filter([{ ...listing, petsAllowed: null }], { pets: true }).length, 0)
  assert.equal(filter([{ ...listing, roomOnly: true }], { roomOnly: true }).length, 1)
  assert.equal(filter([listing], { roomOnly: true }).length, 0)
})
