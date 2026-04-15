import { useState, useCallback, useRef } from 'react'
import { Upload, FileText, Loader2 } from 'lucide-react'

interface PaperUploadProps {
  onUpload: (file: File) => Promise<void>
  uploading: boolean
  error?: string | null
}

export function PaperUpload({ onUpload, uploading, error }: PaperUploadProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'))
      if (pdfs.length === 0) {
        alert('Only PDF files are accepted')
        return
      }
      // Upload all PDFs (each triggers its own ingestion)
      await Promise.all(pdfs.map(f => onUpload(f)))
    },
    [onUpload]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleClick = () => inputRef.current?.click()

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
      e.target.value = '' // reset so same files can be re-selected
    }
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
      className={`
        border-2 border-dashed rounded-xl p-6 cursor-pointer
        flex flex-col items-center gap-3 transition-all duration-150
        ${dragOver
          ? 'border-gold bg-gold/5'
          : 'border-border hover:border-gold/40 hover:bg-bg-hover'
        }
      `}
    >
      <label htmlFor="pdf-upload" className="sr-only">Upload PDFs</label>
      <input
        ref={inputRef}
        id="pdf-upload"
        type="file"
        accept=".pdf"
        multiple
        onChange={handleInputChange}
        className="hidden"
      />
      {uploading ? (
        <>
          <Loader2 size={24} className="text-gold animate-spin" />
          <span className="text-sm text-gold font-medium">Uploading...</span>
        </>
      ) : (
        <>
          <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
            {dragOver ? (
              <FileText size={20} className="text-gold" />
            ) : (
              <Upload size={20} className="text-gold" />
            )}
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-text">
              {dragOver ? 'Drop PDFs here' : 'Upload papers'}
            </p>
            <p className="text-xs text-text-muted mt-1">
              Drag & drop or click to browse — multiple files supported
            </p>
          </div>
        </>
      )}
      {error && (
        <p className="text-xs text-red-400 mt-2 text-center">{error}</p>
      )}
    </div>
  )
}
