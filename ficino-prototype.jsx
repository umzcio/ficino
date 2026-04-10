import { useState } from "react";
import {
  MessageCircle, Repeat2, Heart, Bookmark, Search,
  Home, Bell, Mail, Settings, Plus, Zap, FileText,
  MoreHorizontal, ChevronRight, BookOpen, ImageIcon,
  ZoomIn
} from "lucide-react";

const PERSONAS = {
  skeptic:       { handle: "@skeptical_methods", name: "Methods Skeptic",  initials: "MS", color: "#e85d4a" },
  hype:          { handle: "@ai_breakthroughs",  name: "AI Breakthroughs", initials: "AB", color: "#f5a623" },
  practitioner:  { handle: "@real_world_ml",     name: "Practitioner Pat", initials: "PP", color: "#4a9eff" },
  methodologist: { handle: "@stats_nerd",        name: "Stats Nerd",       initials: "SN", color: "#a78bfa" },
  gradstudent:   { handle: "@phd_suffering",     name: "PhD Candidate",    initials: "PC", color: "#34d399" }
};

// Synthetic figure — a simple SVG bar chart simulating an extracted academic figure
const FigureSVG = () => (
  <svg viewBox="0 0 420 220" xmlns="http://www.w3.org/2000/svg" style={{ width: "100%", height: "100%" }}>
    <rect width="420" height="220" fill="#0d0f14" rx="4"/>

    {/* Grid lines */}
    {[40, 80, 120, 160].map((y, i) => (
      <line key={i} x1="48" y1={y} x2="400" y2={y} stroke="#1e2028" strokeWidth="1"/>
    ))}

    {/* Y axis labels */}
    {["80%", "60%", "40%", "20%"].map((label, i) => (
      <text key={i} x="42" y={44 + i * 40} fill="#555d6e" fontSize="9" textAnchor="end" dominantBaseline="middle">{label}</text>
    ))}

    {/* Bars */}
    {[
      { label: "Implicit\nAlign.", value: 71.2, x: 72,  color: "#c8a96e" },
      { label: "Explicit\nAlign.", value: 43.8, x: 148, color: "#4a9eff" },
      { label: "No\nAlign.",       value: 28.9, x: 224, color: "#e85d4a" },
      { label: "Partial\nAlign.",  value: 56.1, x: 300, color: "#a78bfa" },
    ].map((bar, i) => {
      const barHeight = (bar.value / 100) * 160;
      const y = 200 - barHeight - 24;
      return (
        <g key={i}>
          <rect x={bar.x} y={y} width="52" height={barHeight} fill={bar.color} rx="3" opacity="0.85"/>
          <text x={bar.x + 26} y={y - 6} fill={bar.color} fontSize="9" textAnchor="middle" fontWeight="700">
            {bar.value}%
          </text>
          {bar.label.split("\n").map((line, li) => (
            <text key={li} x={bar.x + 26} y={196 + li * 11} fill="#8b92a5" fontSize="8" textAnchor="middle">
              {line}
            </text>
          ))}
        </g>
      );
    })}

    {/* Axes */}
    <line x1="48" y1="180" x2="400" y2="180" stroke="#2f3540" strokeWidth="1.5"/>
    <line x1="48" y1="20"  x2="48"  y2="180" stroke="#2f3540" strokeWidth="1.5"/>

    {/* Title */}
    <text x="224" y="13" fill="#8b92a5" fontSize="9" textAnchor="middle">
      Figure 3 — AI Competency Alignment by Category (n=2,012 syllabi)
    </text>
  </svg>
);

const FEED = [
  {
    id: 1, persona: "hype", type: "post", time: "2m",
    paper: "Smith et al. 2025",
    content: "MASSIVE new finding: AI-built tools show 71.2% implicit alignment with learning competencies across 2,012 syllabi. Higher ed will never be the same.",
    likes: 847, retweets: 312, replies: 94, bookmarks: 203
  },
  {
    id: 2, persona: "methodologist", type: "figure", time: "5m",
    paper: "Smith et al. 2025",
    content: "Figure 3 tells the real story here. Implicit alignment at 71.2% dwarfs explicit alignment at 43.8% — meaning most instructors are accidentally teaching AI competencies without knowing it. The gap between implicit and explicit is the whole argument of this paper.",
    figureCaption: "Fig. 3 — AI Competency Alignment by Category across 2,012 syllabi. Smith et al. 2025.",
    likes: 1893, retweets: 723, replies: 234, bookmarks: 891
  },
  {
    id: 3, persona: "skeptic", type: "quote", time: "7m",
    paper: "Smith et al. 2025",
    quoting: { handle: "@ai_breakthroughs", content: "MASSIVE new finding: AI-built tools show 71.2% implicit alignment..." },
    content: "\"Implicit alignment\" is doing a lot of work here. How was alignment operationalized? Who coded the syllabi? What's the inter-rater reliability? I'll wait.",
    likes: 1203, retweets: 445, replies: 187, bookmarks: 89
  },
  {
    id: 4, persona: "gradstudent", type: "thread", time: "9m",
    paper: "Smith et al. 2025", threadCount: 7,
    content: "ok I read the whole AIF paper and I have thoughts (1/7)\n\nThe intake framework is actually clever — it's not just a checklist, it's a structured governance layer between the AI tool and institutional deployment. Let me break this down...",
    likes: 567, retweets: 234, replies: 89, bookmarks: 445
  },
  {
    id: 5, persona: "practitioner", type: "post", time: "14m",
    paper: "Chen & Park 2023",
    content: "People keep citing Chen & Park 2023 on AI governance frameworks but nobody mentions their data was entirely from R1 institutions. How does this apply to regional comprehensives with 3-person IT departments?",
    likes: 2341, retweets: 876, replies: 342, bookmarks: 156
  },
  {
    id: 6, persona: "methodologist", type: "reply", time: "17m",
    paper: "Chen & Park 2023", replyingTo: "@real_world_ml",
    content: "This. Also their governance index was never validated against actual outcomes — face validity only. Smith's AIF at least has 21-day deployment data to ground it.",
    likes: 891, retweets: 203, replies: 67, bookmarks: 112
  },
  {
    id: 7, persona: "gradstudent", type: "post", time: "22m",
    paper: null,
    content: "genuinely cannot decide if the gap between AI governance theory and what actually gets implemented at institutions is a research problem or just a \"nobody has time for this\" problem\n\nasking for my dissertation",
    likes: 4521, retweets: 1893, replies: 567, bookmarks: 892
  },
  {
    id: 8, persona: "practitioner", type: "reply", time: "24m",
    paper: null, replyingTo: "@phd_suffering",
    content: "It's both, but the second one causes the first one. Study the gap between governance policy adoption and actual practitioner behavior. That's your contribution right there.",
    likes: 2103, retweets: 445, replies: 123, bookmarks: 334
  },
];

function formatNum(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

function Avatar({ persona }) {
  const p = PERSONAS[persona];
  return (
    <div style={{
      width: 42, height: 42, borderRadius: "50%", flexShrink: 0,
      backgroundColor: p.color + "28", border: `2px solid ${p.color}50`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 13, fontWeight: 700, color: p.color, letterSpacing: "0.02em"
    }}>
      {p.initials}
    </div>
  );
}

function ActionBtn({ icon: Icon, count, color, active, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick && onClick(); }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        background: "none", border: "none", cursor: "pointer",
        display: "flex", alignItems: "center", gap: 5,
        padding: "6px 10px", borderRadius: 20, fontSize: 13,
        color: active ? color : h ? color : "#71767b",
        backgroundColor: h || active ? color + "15" : "transparent",
        transition: "all 0.12s", flex: 1, justifyContent: "center", maxWidth: 80
      }}
    >
      <Icon size={16} strokeWidth={active ? 2.5 : 1.75} fill={active && color === "#f91880" ? color : "none"} />
      <span style={{ fontSize: 13 }}>{formatNum(count)}</span>
    </button>
  );
}

function FigureBlock({ caption }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
        style={{
          border: "1px solid #1e2028",
          borderRadius: 12,
          overflow: "hidden",
          cursor: "zoom-in",
          position: "relative",
          backgroundColor: "#0d0f14",
          transition: "border-color 0.12s"
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = "#c8a96e40"}
        onMouseLeave={e => e.currentTarget.style.borderColor = "#1e2028"}
      >
        {/* Figure label pill */}
        <div style={{
          position: "absolute", top: 10, left: 10, zIndex: 2,
          display: "flex", alignItems: "center", gap: 5,
          backgroundColor: "#080a0fcc", backdropFilter: "blur(8px)",
          border: "1px solid #c8a96e30", borderRadius: 6,
          padding: "3px 8px"
        }}>
          <ImageIcon size={10} color="#c8a96e" />
          <span style={{ fontSize: 10, color: "#c8a96e", fontWeight: 600, letterSpacing: "0.05em" }}>
            EXTRACTED FIGURE
          </span>
        </div>

        {/* Zoom hint */}
        <div style={{
          position: "absolute", top: 10, right: 10, zIndex: 2,
          backgroundColor: "#080a0fcc", backdropFilter: "blur(8px)",
          border: "1px solid #2f3540", borderRadius: 6, padding: "3px 6px",
          display: "flex", alignItems: "center", gap: 4
        }}>
          <ZoomIn size={10} color="#555d6e" />
          <span style={{ fontSize: 10, color: "#555d6e" }}>expand</span>
        </div>

        <div style={{ height: expanded ? 320 : 200, transition: "height 0.2s ease" }}>
          <FigureSVG />
        </div>
      </div>

      {/* Caption */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 6,
        marginTop: 6, padding: "0 2px"
      }}>
        <FileText size={11} color="#555d6e" style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: 12, color: "#555d6e", lineHeight: 1.4, fontStyle: "italic" }}>
          {caption}
        </span>
      </div>
    </div>
  );
}

function PostCard({ post }) {
  const p = PERSONAS[post.persona];
  const [liked, setLiked] = useState(false);
  const [retweeted, setRetweeted] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isFigure = post.type === "figure";

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderBottom: "1px solid #1e2028",
        padding: "14px 16px",
        display: "flex",
        gap: 12,
        backgroundColor: hovered ? "#0d0f14" : "transparent",
        transition: "background 0.12s",
        cursor: "pointer",
        // Subtle left accent for figure posts
        borderLeft: isFigure ? "3px solid #c8a96e30" : "3px solid transparent"
      }}
    >
      <Avatar persona={post.persona} />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#e8eaf0" }}>{p.name}</span>
          <span style={{ fontSize: 14, color: "#555d6e" }}>{p.handle}</span>
          <span style={{ fontSize: 14, color: "#555d6e" }}>·</span>
          <span style={{ fontSize: 14, color: "#555d6e" }}>{post.time}</span>
          {post.type === "thread" && (
            <span style={{
              fontSize: 11, color: "#c8a96e", backgroundColor: "#c8a96e12",
              border: "1px solid #c8a96e30", borderRadius: 4, padding: "1px 6px",
              fontWeight: 600, letterSpacing: "0.03em"
            }}>THREAD {post.threadCount}</span>
          )}
          {isFigure && (
            <span style={{
              fontSize: 11, color: "#a78bfa", backgroundColor: "#a78bfa12",
              border: "1px solid #a78bfa30", borderRadius: 4, padding: "1px 6px",
              fontWeight: 600, letterSpacing: "0.03em",
              display: "flex", alignItems: "center", gap: 3
            }}>
              <ImageIcon size={9} />
              FIGURE
            </span>
          )}
          <div style={{ marginLeft: "auto" }}>
            <MoreHorizontal size={16} color="#555d6e" />
          </div>
        </div>

        {/* Replying to */}
        {post.replyingTo && (
          <div style={{ fontSize: 13, color: "#555d6e", marginBottom: 4 }}>
            Replying to <span style={{ color: "#c8a96e" }}>{post.replyingTo}</span>
          </div>
        )}

        {/* Paper tag */}
        {post.paper && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
            <FileText size={11} color="#555d6e" />
            <span style={{
              fontSize: 11, color: "#8b92a5",
              backgroundColor: "#c8a96e0a", border: "1px solid #c8a96e20",
              borderRadius: 4, padding: "1px 7px"
            }}>{post.paper}</span>
          </div>
        )}

        {/* Content */}
        <p style={{
          margin: "4px 0 10px", fontSize: 15, color: "#e8eaf0",
          lineHeight: 1.55, whiteSpace: "pre-wrap"
        }}>
          {post.content}
        </p>

        {/* Figure block */}
        {isFigure && (
          <FigureBlock caption={post.figureCaption} />
        )}

        {/* Quote block */}
        {post.type === "quote" && post.quoting && (
          <div style={{
            border: "1px solid #1e2028", borderRadius: 12, padding: "10px 14px",
            marginBottom: 10, backgroundColor: "#0d0f14"
          }}>
            <div style={{ fontSize: 13, color: "#555d6e", marginBottom: 3, fontWeight: 600 }}>
              {post.quoting.handle}
            </div>
            <div style={{ fontSize: 13, color: "#b0b8c8", lineHeight: 1.4 }}>
              {post.quoting.content}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", marginLeft: -8, marginTop: 4 }}>
          <ActionBtn icon={MessageCircle} count={post.replies} color="#4a9eff" />
          <ActionBtn icon={Repeat2} count={post.retweets + (retweeted ? 1 : 0)} color="#34d399" active={retweeted} onClick={() => setRetweeted(!retweeted)} />
          <ActionBtn icon={Heart} count={post.likes + (liked ? 1 : 0)} color="#f91880" active={liked} onClick={() => setLiked(!liked)} />
          <ActionBtn icon={Bookmark} count={post.bookmarks + (bookmarked ? 1 : 0)} color="#c8a96e" active={bookmarked} onClick={() => setBookmarked(!bookmarked)} />
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const papers = [
    { title: "Smith et al. 2025", tag: "AI Governance", chunks: 47 },
    { title: "Chen & Park 2023",       tag: "Higher Ed IT",  chunks: 32 },
    { title: "Williams et al. 2024",   tag: "Agentic AI",    chunks: 61 },
    { title: "Cihon et al. 2021",      tag: "Risk Frameworks", chunks: 28 },
  ];

  return (
    <div style={{ width: 260, flexShrink: 0, padding: "12px 0 0 20px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{
        backgroundColor: "#0d0f14", border: "1px solid #1e2028",
        borderRadius: 24, padding: "10px 16px",
        display: "flex", alignItems: "center", gap: 10
      }}>
        <Search size={16} color="#555d6e" />
        <span style={{ color: "#555d6e", fontSize: 15 }}>Search corpus...</span>
      </div>

      <div style={{ backgroundColor: "#0d0f14", border: "1px solid #1e2028", borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#c8a96e", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
          Active Corpus
        </div>
        {papers.map((paper, i) => (
          <div key={i} style={{
            padding: "8px 0",
            borderBottom: i < papers.length - 1 ? "1px solid #1e2028" : "none",
            display: "flex", justifyContent: "space-between", alignItems: "center"
          }}>
            <div>
              <div style={{ fontSize: 13, color: "#e8eaf0", fontWeight: 600, marginBottom: 2 }}>{paper.title}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#c8a96e" }}>{paper.tag}</span>
                <span style={{ fontSize: 12, color: "#555d6e" }}>{paper.chunks} chunks</span>
              </div>
            </div>
            <ChevronRight size={14} color="#555d6e" />
          </div>
        ))}
        <button style={{
          marginTop: 12, width: "100%", backgroundColor: "transparent",
          border: "1px solid #c8a96e40", borderRadius: 20, color: "#c8a96e",
          padding: "8px 0", cursor: "pointer", fontSize: 14, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6
        }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = "#c8a96e12"}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <Plus size={14} />
          Add Paper
        </button>
      </div>

      <div style={{ backgroundColor: "#0d0f14", border: "1px solid #1e2028", borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#c8a96e", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
          Personas
        </div>
        {Object.entries(PERSONAS).map(([key, p]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              backgroundColor: p.color + "22", border: `1.5px solid ${p.color}50`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, color: p.color
            }}>{p.initials}</div>
            <div>
              <div style={{ fontSize: 13, color: "#e8eaf0", fontWeight: 600 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: "#555d6e" }}>{p.handle}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState(0);
  const tabs = ["For You", "Debates", "Methods", "Findings"];

  return (
    <div style={{
      minHeight: "100vh",
      backgroundColor: "#080a0f",
      color: "#e8eaf0",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    }}>
      <style>{`* { box-sizing: border-box; } body { margin: 0; }`}</style>

      <div style={{ maxWidth: 1050, margin: "0 auto", display: "flex", minHeight: "100vh" }}>

        {/* Left nav */}
        <div style={{
          width: 64, flexShrink: 0, display: "flex", flexDirection: "column",
          alignItems: "center", padding: "20px 0", gap: 2,
          borderRight: "1px solid #1e2028"
        }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg, #c8a96e, #a07840)",
              display: "flex", alignItems: "center", justifyContent: "center"
            }}>
              <BookOpen size={18} color="#080a0f" strokeWidth={2.5} />
            </div>
          </div>

          {[Home, Search, Bell, Mail, Bookmark, Settings].map((Icon, i) => (
            <button key={i} style={{
              width: 46, height: 46, borderRadius: 23, border: "none",
              backgroundColor: "transparent", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: i === 0 ? "#e8eaf0" : "#555d6e",
              transition: "all 0.12s"
            }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#c8a96e12"; e.currentTarget.style.color = "#c8a96e"; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = i === 0 ? "#e8eaf0" : "#555d6e"; }}
            >
              <Icon size={20} strokeWidth={i === 0 ? 2.25 : 1.75} />
            </button>
          ))}
        </div>

        {/* Feed */}
        <div style={{ flex: 1, borderRight: "1px solid #1e2028", maxWidth: 600 }}>
          <div style={{
            position: "sticky", top: 0, zIndex: 10,
            backgroundColor: "rgba(8,10,15,0.90)", backdropFilter: "blur(12px)",
            borderBottom: "1px solid #1e2028", padding: "14px 16px",
            display: "flex", alignItems: "center", justifyContent: "space-between"
          }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: "#e8eaf0", letterSpacing: "-0.02em" }}>
                  ficino
                </span>
                <span style={{
                  fontSize: 11, color: "#c8a96e", backgroundColor: "#c8a96e15",
                  border: "1px solid #c8a96e30", borderRadius: 4,
                  padding: "2px 6px", fontWeight: 600, letterSpacing: "0.05em"
                }}>BETA</span>
              </div>
              <div style={{ fontSize: 12, color: "#555d6e", marginTop: 1 }}>
                4 papers · 5 personas · generating
              </div>
            </div>
            <button style={{
              background: "linear-gradient(135deg, #c8a96e, #a07840)",
              border: "none", borderRadius: 20,
              color: "#080a0f", padding: "8px 14px", cursor: "pointer",
              fontSize: 14, fontWeight: 700,
              display: "flex", alignItems: "center", gap: 6
            }}>
              <Zap size={14} />
              Generate
            </button>
          </div>

          <div style={{ display: "flex", borderBottom: "1px solid #1e2028" }}>
            {tabs.map((tab, i) => (
              <button key={i} onClick={() => setActiveTab(i)} style={{
                flex: 1, padding: "14px 0", border: "none", backgroundColor: "transparent",
                color: activeTab === i ? "#e8eaf0" : "#555d6e",
                fontSize: 15, fontWeight: activeTab === i ? 700 : 400, cursor: "pointer",
                borderBottom: activeTab === i ? "2px solid #c8a96e" : "2px solid transparent",
                transition: "all 0.15s"
              }}>{tab}</button>
            ))}
          </div>

          {FEED.map(post => <PostCard key={post.id} post={post} />)}

          <div style={{ padding: 20, textAlign: "center" }}>
            <button style={{
              backgroundColor: "transparent", border: "1px solid #1e2028",
              borderRadius: 20, color: "#c8a96e", padding: "10px 24px",
              cursor: "pointer", fontSize: 15, fontWeight: 600
            }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = "#c8a96e10"}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
            >
              Generate more posts
            </button>
          </div>
        </div>

        <Sidebar />
      </div>
    </div>
  );
}
