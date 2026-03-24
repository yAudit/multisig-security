'use client';

import MultisigChecker from '@/components/MultisigChecker';

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 py-6 sm:py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-2 sm:mb-4">
            Multisig Security Checker
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Analyze your Safe multisig contract for security best practices.<br/>
            Enter an address to get started. More info in <a
              href="https://blog.yaudit.dev/multisig-security" target="_blank"
              rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">the blog</a>.
          </p>
        </div>

        <MultisigChecker />

        <div className="text-center mt-12">
          <p className="text-sm text-gray-500">
            Comments? Suggestions? dm{' '}
            <a
              href="https://x.com/bl4ckb1rd71"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline"
            >
              engn33r
            </a>
            {' '}or create a{' '}
             <a
              href="https://github.com/yaudit/multisig-security"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 underline">
                repo PR
              </a>
          </p>
        </div>
      </div>
    </div>
  );
}
