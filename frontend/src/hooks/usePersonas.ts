import { useState, useEffect, createContext, useContext } from 'react'
import { listPersonas, type PersonaData } from '../lib/api'
import { cachePersonas, getCachedPersonas } from '../lib/offline-cache'

export type PersonaMap = Record<string, PersonaData>

const PersonasContext = createContext<PersonaMap>({})

export function usePersonasLoader() {
  const [personas, setPersonas] = useState<PersonaMap>({})

  useEffect(() => {
    listPersonas()
      .then((list) => {
        cachePersonas(list).catch(() => {})
        const map: PersonaMap = {}
        for (const p of list) map[p.key] = p
        setPersonas(map)
      })
      .catch(async () => {
        try {
          const cached = await getCachedPersonas()
          if (cached.length > 0) {
            const map: PersonaMap = {}
            for (const p of cached) map[p.key] = p
            setPersonas(map)
          }
        } catch { /* ignore */ }
      })
  }, [])

  return personas
}

export const PersonasProvider = PersonasContext.Provider

export function usePersonas(): PersonaMap {
  return useContext(PersonasContext)
}
