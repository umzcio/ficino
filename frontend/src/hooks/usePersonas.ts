import { useState, useEffect, createContext, useContext } from 'react'
import { listPersonas, type PersonaData } from '../lib/api'

export type PersonaMap = Record<string, PersonaData>

const PersonasContext = createContext<PersonaMap>({})

export function usePersonasLoader() {
  const [personas, setPersonas] = useState<PersonaMap>({})

  useEffect(() => {
    listPersonas().then((list) => {
      const map: PersonaMap = {}
      for (const p of list) map[p.key] = p
      setPersonas(map)
    })
  }, [])

  return personas
}

export const PersonasProvider = PersonasContext.Provider

export function usePersonas(): PersonaMap {
  return useContext(PersonasContext)
}
