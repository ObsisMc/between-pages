import { z } from 'zod';

// Pokes and pets between the two people bound in a space (window-mascots ADR): only the
// count of what the partner sent that the caller has not seen yet, never anything of the
// partner's own state. `received` is null while there is none or the caller is not bound.

export const PokeKind = z.enum(['poke', 'pet']).meta({ id: 'PokeKind' });

export const SendPokeRequest = z.strictObject({ kind: PokeKind }).meta({ id: 'SendPokeRequest' });

/** How many of each the caller has shown; the server takes them off what is waiting (D4). */
export const SeenPokesRequest = z
  .strictObject({
    pokes: z.number().int().min(0).max(1_000_000),
    pets: z.number().int().min(0).max(1_000_000),
  })
  .meta({ id: 'SeenPokesRequest' });

export const PokesResponse = z
  .object({
    received: z
      .object({
        pokes: z.number().int().min(0),
        pets: z.number().int().min(0),
        lastAt: z.iso.datetime(),
      })
      .nullable(),
  })
  .meta({ id: 'PokesResponse' });
