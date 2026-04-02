'use client'

import { Card, CardContent } from '@/components/ui/card'

interface Props {
  eventsToday: number
  pendingReview: number
  postedToday: number
  sourcesActive: number
}

export function StatsBar({ eventsToday, pendingReview, postedToday, sourcesActive }: Props) {
  const stats = [
    { label: 'Events Today', value: eventsToday, color: 'text-blue-600' },
    { label: 'Pending Review', value: pendingReview, color: pendingReview > 0 ? 'text-orange-500' : 'text-gray-700' },
    { label: 'Posted Today', value: postedToday, color: 'text-green-600' },
    { label: 'Sources Active', value: sourcesActive, color: 'text-purple-600' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map(s => (
        <Card key={s.label}>
          <CardContent className="pt-4 pb-4">
            <div className={`text-3xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-sm text-muted-foreground mt-1">{s.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
