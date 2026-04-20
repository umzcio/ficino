import { useUserPosts } from '../../hooks/useUserPosts'
import { UserPostCard } from '../Feed/UserPostCard'
import { SwipeBackEdge } from '../_shared/SwipeBackEdge'

interface UserProfileProps {
  workspaceId: string | null
  displayName: string
  handle: string
  onBack: () => void
  onPersonaClick?: (key: string) => void
}

export function UserProfile({ workspaceId, displayName, handle, onBack, onPersonaClick }: UserProfileProps) {
  const { posts, refresh } = useUserPosts(workspaceId)

  return (
    <div>
      <SwipeBackEdge onBack={onBack} />
      {/* Profile header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          aria-label="Back"
          className="bg-transparent border-none cursor-pointer text-text p-2 hover:bg-bg-hover rounded-full"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div>
          <div className="font-bold text-[17px] text-text">{displayName}</div>
          <div className="text-[13px] text-text-muted">{posts.length} post{posts.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* Profile card */}
      <div className="px-4 py-5 border-b border-border">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-16 h-16 rounded-full bg-gold/15 flex items-center justify-center text-[18px] font-bold text-gold">
            You
          </div>
          <div>
            <div className="font-bold text-[20px] text-text">{displayName}</div>
            <div className="text-[15px] text-text-muted">{handle}</div>
          </div>
        </div>
        <p className="text-[14px] text-text-mid leading-relaxed">
          Your posts and questions to the corpus. The Archivist responds with grounded answers from your uploaded papers.
        </p>
      </div>

      {/* Posts */}
      {posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-text-muted">
          <p className="text-sm">No posts yet. Use the compose box to ask your corpus a question.</p>
        </div>
      ) : (
        posts.map((post) => (
          <UserPostCard
            key={post.id}
            post={post}
            userDisplayName={displayName}
            userHandle={handle}
            onDeleted={refresh}
            onPersonaClick={onPersonaClick}
          />
        ))
      )}
    </div>
  )
}
