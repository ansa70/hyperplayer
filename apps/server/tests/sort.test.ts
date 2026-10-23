import { expect, test } from "vite-plus/test";
import { sortKey } from "../src/db.ts";

test("artists sort by their shown name, ignoring case, accents and a leading article", () => {
  const names = [
    "the George Benson Quartet",
    "Björk",
    "Miles Davis",
    "Arvo Pärt",
    "bill Evans",
    "The Beatles",
    "A Tribe Called Quest",
    "Area",
  ];
  expect([...names].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual([
    "Area",
    "Arvo Pärt",
    "The Beatles",
    "bill Evans",
    "Björk",
    "the George Benson Quartet",
    "Miles Davis",
    "A Tribe Called Quest",
  ]);
});
