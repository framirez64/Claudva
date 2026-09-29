import { createContext, useContext } from 'react';

// Shared app state: data, calendar, lookups, routing, drawer and toast helpers.
export const Ctx = createContext(null);
export const useAula = () => useContext(Ctx);
