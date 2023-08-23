#include <iostream>
#include <algorithm>
using namespace std;

int main() {
   int arr[] = {-1, 0, 1, 2, -1, -4};
   int n = sizeof(arr) / sizeof(arr[0]);

   // Sort the array to handle duplicates
   sort(arr, arr + n);

   for (int i = 0; i < n; i++) {
       // Skip duplicate elements for the first position
       if (i > 0 && arr[i] == arr[i - 1]) {
           continue;
       }

       for (int j = i + 1; j < n - 1; j++) {
           // Skip duplicate elements for the second position
           if (j > i + 1 && arr[j] == arr[j - 1]) {
               continue;
           }

           for (int k = i + 2; k < n; k++) {
               if (arr[i] + arr[j] + arr[k] == 0) {
                   cout << arr[i] << " " << arr[j] << " " << arr[k] << endl;
               }
           }
       }
   }

   return 0;
}
