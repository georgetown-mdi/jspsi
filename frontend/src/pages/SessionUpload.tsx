import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import FileUpload from '@/components/FileUpload'; // adjust import as needed

const SessionUpload = () => {
  const { sessionId } = useParams();
  const [sessionInfo, setSessionInfo] = useState(null);
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    // Fetch session info from backend
    const fetchSession = async () => {
      const res = await fetch(`/api/session/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        setSessionInfo(data);
      }
    };
    fetchSession();
  }, [sessionId]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-blue-50">
      <div className="bg-white/80 border border-blue-100 shadow-lg rounded-2xl p-8 max-w-lg w-full">
        <h2 className="text-2xl font-bold text-gray-900 mb-4 text-center">
          Upload Your CSV
        </h2>
        {sessionInfo ? (
          <div className="mb-6">
            <div className="mb-2">
              <span className="font-semibold">Your Name:</span>{' '}
              {sessionInfo.initiatedName}
            </div>
            <div className="mb-2">
              <span className="font-semibold">Invited Name:</span>{' '}
              {sessionInfo.invitedName}
            </div>
            <div className="mb-2">
              <span className="font-semibold">Description:</span>{' '}
              {sessionInfo.description}
            </div>
          </div>
        ) : (
          <div className="mb-6 text-center text-gray-500">
            Loading session info...
          </div>
        )}
        <FileUpload
          onFileSelect={setFile}
          selectedFile={file}
          accept=".csv"
          maxSize={10 * 1024 * 1024}
        />
        {/* Optionally, show file name or preview here */}
      </div>
    </div>
  );
};

export default SessionUpload;
